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

    console.log('📡 Destinos de transmissão:');
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

    // Cria o filtro concat para ffmpeg, lista os inputs separados
    const filterComplex = tsList
      .map((_, i) => `[${i}:v:0][${i}:a:0]`)
      .join('') + `concat=n=${tsList.length}:v=1:a=1[outv][outa]`;

    // Monta os argumentos do ffmpeg com múltiplos inputs (cada ts um -i)
    const ffmpegArgs = [];

    tsList.forEach(tsFile => {
      ffmpegArgs.push('-i', tsFile);
    });

    ffmpegArgs.push(
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-c:a', 'aac',
      '-ar', '44100',
      '-b:a', '128k',
      '-f', 'tee',
      destinos.map(url => `[f=flv:onfail=ignore]${url}`).join('|')
    );

    console.log('▶️ Comando FFmpeg:');
    console.log(`ffmpeg ${ffmpegArgs.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

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

    let stderrLogs = '';
    ffmpeg.stderr.on('data', d => {
      const output = d.toString();
      stderrLogs += output;
      process.stderr.write(output);
    });

    await new Promise((resolve, reject) => {
      ffmpeg.on('close', code => {
        clearInterval(intervalo);
        process.stdout.write('\n');

        if (code === 0) {
          console.log(`✅ Transmissão concluída com sucesso.`);
          notificarStatus('finished', streamInfo.id);
          limparArtefatos();
          resolve();
        } else {
          console.error(`❌ Falha na transmissão. Código: ${code}`);
          notificarStatus('error', streamInfo.id);
          limparArtefatos();
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
