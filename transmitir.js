// transmitir.js
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

    const concatStr = `concat:${tsList.join('|')}`;
    console.log(`📡 Conectando ao servidor de streaming e iniciando transmissão...\n`);

    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', concatStr,
      '-c', 'copy',
      '-f', 'flv',
      streamInfo.stream_url
    ]);

    // ⏱️ Notificar "started" após 5 segundos
    setTimeout(() => {
      notificarStatus('started', streamInfo.id);
    }, 5000);

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
      ffmpeg.on('close', code => {
        clearInterval(intervalo);
        process.stdout.write('\n');
        limparArtefatos();
        if (code === 0) {
          console.log('✅ Transmissão finalizada com sucesso!');
          notificarStatus('finished', streamInfo.id);
          resolve();
        } else {
          console.error(`❌ Falha na transmissão. Código: ${code}`);
          notificarStatus('error', streamInfo.id);
          reject(new Error(`FFmpeg falhou com código ${code}`));
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
