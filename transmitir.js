const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const https = require('https');
const mime = require('mime-types');

const artefatosDir = path.resolve('artefatos');
const tsListPath = path.join(artefatosDir, 'ts_paths.json');
const streamInfoPath = path.join(artefatosDir, 'stream_info.json');
const rodapeUrl = 'https://livestream.ct.ws/Google%20drive/rodape/rodap%C3%A9.png';

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
  console.log('\n🧹 Limpando arquivos em artefatos...');
  if (!fs.existsSync(artefatosDir)) return;
  const arquivos = fs.readdirSync(artefatosDir);
  for (const arquivo of arquivos) {
    const caminho = path.join(artefatosDir, arquivo);
    try {
      if (fs.lstatSync(caminho).isFile()) {
        fs.unlinkSync(caminho);
        console.log(`🗑️ Removido: ${caminho}`);
      }
    } catch (err) {
      console.warn(`⚠️ Falha ao remover: ${caminho} - ${err.message}`);
    }
  }
}

function baixarImagemRodape(url, destino) {
  return new Promise((resolve, reject) => {
    const arquivo = fs.createWriteStream(destino);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`❌ Erro ao baixar imagem: HTTP ${res.statusCode}`));
        return;
      }

      const contentType = res.headers['content-type'] || '';
      if (!contentType.startsWith('image/')) {
        reject(new Error(`❌ Conteúdo baixado não é uma imagem: tipo = ${contentType}`));
        return;
      }

      res.pipe(arquivo);
      arquivo.on('finish', () => {
        arquivo.close(() => {
          const mimeType = mime.lookup(destino);
          if (!mimeType || !mimeType.startsWith('image/')) {
            reject(new Error(`❌ Arquivo salvo não é imagem válida: ${destino}`));
          } else {
            console.log(`🖼️ Rodapé salvo e validado: ${destino}`);
            resolve();
          }
        });
      });
    }).on('error', err => {
      reject(new Error(`❌ Erro ao baixar imagem: ${err.message}`));
    });
  });
}

(async () => {
  try {
    console.log('🚀 Iniciando transmissão...');

    if (!fs.existsSync(tsListPath) || !fs.existsSync(streamInfoPath)) {
      throw new Error('Arquivos essenciais não encontrados: ts_paths.json ou stream_info.json');
    }

    const tsListRaw = JSON.parse(fs.readFileSync(tsListPath, 'utf-8'));
    const streamInfo = JSON.parse(fs.readFileSync(streamInfoPath, 'utf-8'));

    const arquivosDisponiveis = new Set(fs.readdirSync(artefatosDir));
    const arquivosVideo = tsListRaw
      .map(f => path.basename(f))
      .filter(f => f.toLowerCase().endsWith('.ts') && arquivosDisponiveis.has(f))
      .map(f => path.join(artefatosDir, f));

    if (arquivosVideo.length === 0) {
      throw new Error('❌ Nenhum arquivo .ts válido encontrado.');
    }

    console.log(`🆔 Live ID: ${streamInfo.id}`);
    console.log(`📡 Stream URL: ${streamInfo.stream_url}\n`);

    console.log('🌐 Baixando rodapé...');
    const rodapePath = path.join(artefatosDir, 'rodape.png');
    await baixarImagemRodape(rodapeUrl, rodapePath);

    let duracaoTotal = 0;
    const sequencia = [];

    for (const arquivo of arquivosVideo) {
      const duracao = await obterDuracao(arquivo);
      duracaoTotal += duracao;
      sequencia.push({ nome: path.basename(arquivo), duracao: formatarTempo(duracao) });
    }

    sequencia.forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.nome} — ${item.duracao}`);
    });

    console.log(`\n⏳ Duração total: ${formatarTempo(duracaoTotal)}\n`);

    const concatStr = `concat:${arquivosVideo.join('|')}`;

    const inicio1 = 240; // 4 minutos
    const fim1 = 250;

    const inicio2 = Math.max(0, duracaoTotal - 240); // 4 min antes do fim
    const fim2 = Math.max(0, duracaoTotal - 230);

    const enableOverlay = `between(t\\,${inicio1}\\,${fim1})+between(t\\,${inicio2}\\,${fim2})`;

    console.log(`📺 Rodapé será exibido entre:`);
    console.log(`   - 4:00 até 4:10`);
    console.log(`   - Faltando 4:00 até 3:50 para acabar\n`);

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
    let rodapeMostrado1 = false;
    let rodapeMostrado2 = false;

    const intervalo = setInterval(() => {
      tempoDecorrido++;
      const restante = duracaoTotal - tempoDecorrido;

      process.stdout.write(`\r⏱️ Tempo transmitido: ${formatarTempo(tempoDecorrido)} — restante: ${formatarTempo(restante)}   `);

      if (!rodapeMostrado1 && tempoDecorrido >= inicio1 && tempoDecorrido < fim1) {
        console.log(`\n🟩 Rodapé sobreposto no tempo: ${formatarTempo(tempoDecorrido)} (início 4m)`);
        rodapeMostrado1 = true;
      }

      if (!rodapeMostrado2 && tempoDecorrido >= inicio2 && tempoDecorrido < fim2) {
        console.log(`\n🟩 Rodapé sobreposto no tempo: ${formatarTempo(tempoDecorrido)} (final -4m)`);
        rodapeMostrado2 = true;
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
          console.log('✅ Transmissão encerrada com sucesso!');
          resolve();
        } else {
          console.error(`❌ Erro na transmissão. Código: ${code}`);
          reject(new Error(`FFmpeg terminou com erro.`));
        }
      });
    });

  } catch (erro) {
    console.error(`\n❌ Erro: ${erro.message}`);
    limparArtefatos();
    process.exit(1);
  }
})();
