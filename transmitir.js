const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

// Diretório onde os arquivos .ts e .json estão
const artefatosDir = path.resolve('artefatos/video_final');

const tsListPath = path.join(artefatosDir, 'ts_paths.json');
const streamInfoPath = path.join(artefatosDir, 'stream_info.json');

// Verifica se os arquivos existem antes de continuar
if (!fs.existsSync(tsListPath) || !fs.existsSync(streamInfoPath)) {
  console.error('❌ Arquivos ts_paths.json ou stream_info.json não encontrados.');
  process.exit(1);
}

const tsList = JSON.parse(fs.readFileSync(tsListPath, 'utf-8'));
const streamInfo = JSON.parse(fs.readFileSync(streamInfoPath, 'utf-8'));

const STATUS_ENDPOINT = process.env.Notificacao_status;

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

async function notificarStatus(status, message = null) {
  if (!STATUS_ENDPOINT) {
    console.warn('⚠️ Variável de ambiente "Notificacao_status" não definida.');
    return;
  }

  // Acesso via navegador headless (GET)
  try {
    console.log(`🌐 Acessando página via Puppeteer: ${STATUS_ENDPOINT}`);
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(STATUS_ENDPOINT, { waitUntil: 'networkidle2' });
    await browser.close();
    console.log('✅ Página carregada com sucesso (Puppeteer).');
  } catch (err) {
    console.warn(`⚠️ Erro ao acessar página com Puppeteer: ${err.message}`);
  }

  // Envio de notificação via POST
  try {
    const body = { id: streamInfo.id, status };
    if (message) body.message = message;

    const res = await fetch(STATUS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const json = await res.json().catch(() => ({}));
    console.log(`📡 Notificação "${status}" enviada → Resposta:`, json);
  } catch (err) {
    console.error(`❌ Falha ao notificar status "${status}": ${err.message}`);
  }
}

(async () => {
  try {
    console.log('🚀 Iniciando transmissão...');
    console.log(`🆔 ID da live: ${streamInfo.id}`);
    console.log(`📡 URL da stream: ${streamInfo.stream_url}\n`);

    console.log('📋 Sequência dos vídeos que serão transmitidos:\n');

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

    await notificarStatus('started');

    const concatStr = `concat:${tsList.join('|')}`;
    console.log(`📡 Conectando ao servidor de streaming e iniciando transmissão...\n`);

    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', concatStr,
      '-c', 'copy',
      '-f', 'flv',
      streamInfo.stream_url
    ]);

    let tempoDecorrido = 0;
    const intervalo = setInterval(() => {
      tempoDecorrido++;
      const restante = duracaoTotal - tempoDecorrido;
      if (restante >= 0) {
        process.stdout.write(`\r⏳ Tempo restante da live: ${formatarTempo(restante)}   `);
      }
    }, 1000);

    ffmpeg.stdout.on('data', d => process.stdout.write(d.toString()));
    ffmpeg.stderr.on('data', d => process.stderr.write(d.toString()));

    await new Promise((resolve, reject) => {
      ffmpeg.on('close', async code => {
        clearInterval(intervalo);
        process.stdout.write('\n');
        limparArtefatos();
        if (code === 0) {
          console.log('✅ Transmissão finalizada com sucesso!');
          await notificarStatus('finished');
          resolve();
        } else {
          console.error(`❌ Falha na transmissão. Código: ${code}`);
          await notificarStatus('error', `FFmpeg retornou código ${code}`);
          reject(new Error(`FFmpeg falhou com código ${code}`));
        }
      });
    });
  } catch (erro) {
    console.error(`\n❌ Erro inesperado: ${erro.message}`);
    await notificarStatus('error', erro.message);
    limparArtefatos();
    process.exit(1);
  }
})();
