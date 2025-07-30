const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const puppeteer = require('puppeteer');

const artefatosDir = path.resolve('artefatos/video_final');
const tsList = JSON.parse(fs.readFileSync(path.join(artefatosDir, 'ts_paths.json'), 'utf-8'));
const streamInfo = JSON.parse(fs.readFileSync(path.join(artefatosDir, 'stream_info.json'), 'utf-8'));

const statusUrl = process.env.Notificacao_status;

function formatarTempo(segundos) {
  const m = Math.floor(segundos / 60);
  const s = Math.round(segundos % 60);
  return `${m}m${s}s`;
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      if (code === 0) resolve(parseFloat(output.trim()));
      else reject(new Error(`❌ ffprobe falhou para arquivo: ${video}`));
    });
  });
}

function limparArtefatos() {
  console.log('\n🧹 Limpando arquivos em artefatos/video_final...');
  if (!fs.existsSync(artefatosDir)) return;
  const arquivos = fs.readdirSync(artefatosDir);
  for (const arquivo of arquivos) {
    const caminho = path.join(artefatosDir, arquivo);
    try {
      fs.unlinkSync(caminho);
      console.log(`🗑️ Removido: ${caminho}`);
    } catch (err) {
      console.warn(`⚠️ Falha ao remover: ${caminho} - ${err.message}`);
    }
  }
}

async function notificarStatus(status, id) {
  if (!statusUrl) {
    console.warn('⚠️ Notificacao_status não definido nas variáveis de ambiente.');
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  try {
    await page.goto(statusUrl, { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 2000));

    const response = await page.evaluate(async ({ status, id, statusUrl }) => {
      const res = await fetch(statusUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, id })
      });
      return await res.text();
    }, { status, id, statusUrl });

    console.log(`📡 Notificação enviada: status="${status}", id="${id}" → Resposta: ${response}`);
  } catch (err) {
    console.error(`❌ Falha ao notificar status "${status}" - ${err.message}`);
  } finally {
    await browser.close();
  }
}

(async () => {
  try {
    console.log('🚀 Iniciando transmissão...');
    console.log(`🆔 ID da live: ${streamInfo.id}`);

    const destinos = Array.isArray(streamInfo.stream_urls)
      ? streamInfo.stream_urls
      : [streamInfo.stream_url];

    if (destinos.length === 0) {
      throw new Error('Nenhuma URL de stream foi fornecida.');
    }

    console.log('📡 Destinos de transmissão (simultâneos):');
    destinos.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));

    console.log('\n📋 Sequência dos vídeos que serão transmitidos:\n');

    let duracaoTotal = 0;
    const sequencia = [];

    for (const arquivo of tsList) {
      const duracao = await obterDuracao(arquivo);
      duracaoTotal += duracao;
      sequencia.push({
        nome: path.basename(arquivo),
        duracao: formatarTempo(duracao),
      });
    }

    sequencia.forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.nome} — duração: ${item.duracao}`);
    });

    console.log(`\n⏳ Duração total estimada da live: ${formatarTempo(duracaoTotal)}\n`);

    const concatStr = `concat:${tsList.join('|')}`;

    // Construção do parâmetro tee para múltiplos destinos com onfail=ignore para cada saída
    const teeOutputs = destinos.map(url => `[f=flv:onfail=ignore]${url}`).join('|');

    const ffmpegArgs = [
      '-re',
      '-i', concatStr,
      '-c', 'copy',
      '-f', 'tee',
      teeOutputs
    ];

    console.log('▶️ Comando FFmpeg completo:');
    console.log(`ffmpeg ${ffmpegArgs.join(' ')}`);

    // Inicia o processo ffmpeg
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    // Variáveis para controlar status das URLs
    const statusPorUrl = {};
    destinos.forEach(url => statusPorUrl[url] = { started: false, erro: false });

    // Função auxiliar para tentar detectar logs de erro ou sucesso por URL
    function analisarLogParaUrl(logLine) {
      destinos.forEach(url => {
        if (logLine.includes(url)) {
          // Detecta erro comum do servidor ou desconexão
          if (/Server returned 5\d\d|Connection refused|Failed to connect|404 Not Found/i.test(logLine)) {
            if (!statusPorUrl[url].erro) {
              console.error(`❌ Erro detectado no stream: ${url} → ${logLine.trim()}`);
              statusPorUrl[url].erro = true;
            }
          } else if (/Press \[q\] to stop/i.test(logLine) || /frame=/i.test(logLine)) {
            // Assumindo que ffmpeg indica início da transmissão
            if (!statusPorUrl[url].started && !statusPorUrl[url].erro) {
              console.log(`✅ Transmissão iniciada com sucesso para: ${url}`);
              statusPorUrl[url].started = true;
            }
          }
        }
      });
    }

    // Observa saída stderr do ffmpeg para detectar erros/sucessos
    ffmpeg.stderr.on('data', data => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          process.stderr.write(line + '\n');
          analisarLogParaUrl(line);
        }
      });
    });

    // Notificação que live iniciou após 5 segundos
    setTimeout(() => {
      notificarStatus('started', streamInfo.id);
    }, 5000);

    // Contador de tempo restante da live
    let tempoDecorrido = 0;
    const intervalo = setInterval(() => {
      tempoDecorrido++;
      const restante = duracaoTotal - tempoDecorrido;
      if (restante >= 0) {
        process.stdout.write(`\r⏳ Tempo restante da live: ${formatarTempo(restante)}   `);
      }
    }, 1000);

    // Espera ffmpeg finalizar
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', code => {
        clearInterval(intervalo);
        process.stdout.write('\n');

        // Lista URLs que iniciaram e que falharam
        const urlsSucesso = destinos.filter(url => statusPorUrl[url].started && !statusPorUrl[url].erro);
        const urlsFalha = destinos.filter(url => statusPorUrl[url].erro || !statusPorUrl[url].started);

        if (urlsSucesso.length > 0) {
          console.log(`✅ Transmissão concluída com sucesso para ${urlsSucesso.length} destino(s):`);
          urlsSucesso.forEach(u => console.log(`   - ${u}`));
          if (urlsFalha.length > 0) {
            console.warn(`⚠️ Algumas URLs falharam na transmissão:`);
            urlsFalha.forEach(u => console.warn(`   - ${u}`));
          }
          notificarStatus('finished', streamInfo.id);
          limparArtefatos();
          resolve();
        } else {
          console.error('❌ Todos os destinos falharam. Transmissão não foi realizada.');
          urlsFalha.forEach(u => console.error(`   - ${u}`));
          notificarStatus('error', streamInfo.id);
          limparArtefatos();
          reject(new Error('Nenhuma das URLs conseguiu iniciar a transmissão.'));
        }
      });
    });

  } catch (erro) {
    console.error(`\n❌ Erro: ${erro.message}`);
    await notificarStatus('error', streamInfo.id);
    limparArtefatos();
    process.exit(1);
  }
})();
