const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const https = require('https');

const artefatosDir = path.resolve('artefatos');
const tsListPath = path.join(artefatosDir, 'ts_paths.json');
const streamInfoPath = path.join(artefatosDir, 'stream_info.json');
const rodapeUrl = 'https://livestream.ct.ws/Google%20drive/rodape/rodapé.html';

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

function baixarRodape(url, destino) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let html = '';
      res.on('data', chunk => html += chunk.toString());
      res.on('end', () => {
        try {
          const json = JSON.parse(html);
          const base64 = json.imagem || json.base64;
          if (!base64) throw new Error('Campo "imagem" ou "base64" não encontrado.');
          const bin = Buffer.from(base64.split(',')[1] || base64, 'base64'); // remove prefixo data:image/png;base64,
          fs.writeFileSync(destino, bin);
          console.log(`🖼️ Rodapé salvo em: ${destino}`);
          resolve();
        } catch (err) {
          console.error('❌ Conteúdo recebido de rodape.html:\n', html);
          reject(new Error('❌ Erro ao processar rodape.html: ' + err.message));
        }
      });
    }).on('error', err => {
      reject(new Error('❌ Erro ao baixar rodapé: ' + err.message));
    });
  });
}

(async () => {
  try {
    console.log('🚀 Iniciando transmissão...');

    if (!fs.existsSync(tsListPath) || !fs.existsSync(streamInfoPath)) {
      throw new Error('Arquivos essenciais não encontrados: ts_paths.json ou stream_info.json');
    }

    const tsList = JSON.parse(fs.readFileSync(tsListPath, 'utf-8'));
    const streamInfo = JSON.parse(fs.readFileSync(streamInfoPath, 'utf-8'));

    console.log(`🆔 ID da live: ${streamInfo.id}`);
    console.log(`📡 URL da stream: ${streamInfo.stream_url}\n`);

    console.log('🌐 Obtendo rodapé remoto...');
    const rodapePath = path.join(artefatosDir, 'rodape.png');
    await baixarRodape(rodapeUrl, rodapePath);

    const arquivosVideo = tsList.filter(f => f.toLowerCase().endsWith('.ts'));

    let duracaoTotal = 0;
    const sequencia = [];

    for (const arquivo of arquivosVideo) {
      const caminho = path.join(artefatosDir, arquivo);
      const duracao = await obterDuracao(caminho);
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

    // Exibir rodapé em 2 momentos específicos
    const concatStr = `concat:${arquivosVideo.map(f => path.join(artefatosDir, f)).join('|')}`;
    const inicioRodape1 = 250;
    const fimRodape1 = 260;
    const inicioRodape2 = Math.max(0, duracaoTotal - 240);
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
