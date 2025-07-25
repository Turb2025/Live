const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const artefatosDir = path.resolve('artefatos/video_final');
const tsList = JSON.parse(fs.readFileSync(path.join(artefatosDir, 'ts_paths.json'), 'utf-8'));
const streamInfo = JSON.parse(fs.readFileSync(path.join(artefatosDir, 'stream_info.json'), 'utf-8'));

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

(async () => {
  try {
    console.log('🚀 Iniciando transmissão...');
    console.log(`🆔 ID da live: ${streamInfo.id}`);
    console.log(`📡 URL da stream: ${streamInfo.stream_url}\n`);

    console.log('📋 Sequência dos vídeos que serão transmitidos:\n');

    let duracaoTotal = 0;
    const sequencia = [];

    for (const arquivo of tsList) {
      if (!arquivo.toLowerCase().endsWith('.ts')) {
        console.log(`ℹ️ Ignorando arquivo não-vídeo para duração: ${arquivo}`);
        continue;
      }
      const duracao = await obterDuracao(arquivo);
      duracaoTotal += duracao;
      sequencia.push({
        nome: path.basename(arquivo),
        duracao: formatarTempo(duracao),
      });
    }

    // Exibir a sequência formatada
    sequencia.forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.nome} — duração: ${item.duracao}`);
    });

    console.log(`\n⏳ Duração total estimada da live: ${formatarTempo(duracaoTotal)}\n`);

    // Separar caminho do rodapé e os arquivos de vídeo .ts
    const arquivosVideo = tsList.filter(f => f.toLowerCase().endsWith('.ts'));
    const rodapePath = tsList.find(f => f.toLowerCase().endsWith('.png'));

    if (!rodapePath || !fs.existsSync(rodapePath)) {
      throw new Error(`Arquivo de rodapé não encontrado: ${rodapePath}`);
    }

    const concatStr = `concat:${arquivosVideo.join('|')}`;

    const inicioRodape1 = 250; // 4min10s
    const fimRodape1 = 260;

    const inicioRodape2 = Math.max(0, duracaoTotal - 240); // Faltando 4min
    const fimRodape2 = Math.max(0, duracaoTotal - 230);

    const enableOverlay = `between(t\\,${inicioRodape1}\\,${fimRodape1})+between(t\\,${inicioRodape2}\\,${fimRodape2})`;

    console.log(`📡 Transmitindo com rodapé visível de 4:10 a 4:20 e novamente faltando 4:00 até 3:50 para o fim.\n`);

    const ffmpeg = spawn('ffmpeg', [
      '-re',
      '-i', concatStr,
      '-i', rodapePath,
      '-filter_complex',
      `[1:v]scale=1280:-1[rodape];[0:v]setpts=PTS-STARTPTS[base];[base][rodape]overlay=enable='${enableOverlay}':x=0:y=H-h[outv]`,
      '-map', '[outv]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'flv',
      streamInfo.stream_url
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

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
          resolve();
        } else {
          console.error(`❌ Falha na transmissão. Código: ${code}`);
          reject(new Error(`FFmpeg falhou com código ${code}`));
        }
      });
    });
  } catch (erro) {
    console.error(`\n❌ Erro: ${erro.message}`);
    limparArtefatos();
    process.exit(1);
  }
})();
