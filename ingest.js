require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pdf = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const { gerarEmbedding } = require('./embeddings');
const { salvarDocumento } = require('./database');

// Diretório onde estão os PDFs
const PASTA_ENTRADA = path.join(__dirname, 'docs');

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

function dividirEmChunks(texto, tamanho = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let inicio = 0;
  const textoLimpo = texto.replace(/\s+/g, ' ').trim();

  while (inicio < textoLimpo.length) {
    const fim = Math.min(inicio + tamanho, textoLimpo.length);
    const chunk = textoLimpo.slice(inicio, fim).trim();
    if (chunk.length > 50) {
      chunks.push(chunk);
    }
    inicio += tamanho - overlap;
  }
  return chunks;
}

/**
 * Converte páginas do PDF em imagem usando o utilitário nativo pdftoppm e aplica OCR
 */
async function extrairTextoViaOcr(caminhoPdf) {
  console.log(`    ↳ [OCR] Iniciando extração óptica para: ${path.basename(caminhoPdf)}...`);
  const pastaTemp = path.join(__dirname, 'temp_ocr');
  if (!fs.existsSync(pastaTemp)) fs.mkdirSync(pastaTemp, { recursive: true });

  const prefixoSaida = path.join(pastaTemp, 'pag');

  // Converte todas as páginas do PDF em imagens PNG de alta resolução (150 DPI)
  execSync(`pdftoppm -png -r 150 "${caminhoPdf}" "${prefixoSaida}"`);

  const arquivosImagens = fs.readdirSync(pastaTemp)
    .filter(arq => arq.startsWith('pag-') && arq.endsWith('.png'))
    .sort()
    .map(arq => path.join(pastaTemp, arq));

  const worker = await createWorker('por');
  let textoTotal = '';

  for (const imagem of arquivosImagens) {
    const ret = await worker.recognize(imagem);
    textoTotal += `\n${ret.data.text}`;
    fs.unlinkSync(imagem); // remove imagem após ler
  }

  await worker.terminate();
  return textoTotal;
}

async function processarArquivo(caminhoArquivo) {
  const nomeArquivo = path.basename(caminhoArquivo);
  console.log(`\n📄 Processando: ${nomeArquivo}`);

  let texto = '';

  if (caminhoArquivo.endsWith('.pdf')) {
    const buffer = fs.readFileSync(caminhoArquivo);
    const dadosPdf = await pdf(buffer);
    texto = dadosPdf.text ? dadosPdf.text.trim() : '';

    if (texto.length < 100) {
      console.log(`    ⚠️ Pouco texto nativo detectado (${texto.length} chars). Ativando fallback para OCR...`);
      texto = await extrairTextoViaOcr(caminhoArquivo);
    }
  } else if (caminhoArquivo.endsWith('.txt') || caminhoArquivo.endsWith('.md')) {
    texto = fs.readFileSync(caminhoArquivo, 'utf-8');
  } else {
    console.log(`    ⏩ Formato ignorado: ${nomeArquivo}`);
    return;
  }

  if (!texto || texto.trim().length < 50) {
    console.log(`    ❌ Não foi possível extrair conteúdo significativo de: ${nomeArquivo}`);
    return;
  }

  const blocos = dividirEmChunks(texto);
  console.log(`    ✂️ Texto dividido em ${blocos.length} chunks. Gerando embeddings...`);

  for (let i = 0; i < blocos.length; i++) {
    const trecho = blocos[i];
    const vetor = await gerarEmbedding(trecho);
    salvarDocumento(trecho, `${nomeArquivo} (parte ${i + 1}/${blocos.length})`, vetor);
    process.stdout.write(`    ⚡ Chunk ${i + 1}/${blocos.length} indexado no SQLite\r`);
  }
  console.log(`\n    ✅ ${nomeArquivo} totalmente indexado na base do Alfred!`);
}

async function iniciarIngestao() {
  if (!fs.existsSync(PASTA_ENTRADA)) {
    fs.mkdirSync(PASTA_ENTRADA, { recursive: true });
    console.log(`Criada a pasta '${PASTA_ENTRADA}'. Deposite seus arquivos PDF, TXT ou MD nela.`);
    return;
  }

  const arquivos = fs.readdirSync(PASTA_ENTRADA);
  if (arquivos.length === 0) {
    console.log(`A pasta '${PASTA_ENTRADA}' está vazia. Adicione arquivos para indexação.`);
    return;
  }

  console.log(`=== Iniciando Pipeline de Ingestão do Alfred ===`);
  console.log(`Encontrados ${arquivos.length} arquivo(s) na fila.\n`);

  for (const arquivo of arquivos) {
    const caminhoCompleto = path.join(PASTA_ENTRADA, arquivo);
    if (fs.statSync(caminhoCompleto).isFile()) {
      try {
        await processarArquivo(caminhoCompleto);
      } catch (err) {
        console.error(`    ❌ Erro ao processar ${arquivo}:`, err.message);
      }
    }
  }

  console.log('\n=== Ingestão concluída com sucesso! ===');
}

iniciarIngestao();