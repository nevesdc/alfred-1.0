# 🦇 Alfred 1.0 - Local RAG Assistant MVP

O **Alfred** é um assistente pessoal de IA construído 100% localmente, projetado para atuar como um "Segundo Cérebro" técnico. Ele ingere documentos (PDFs, TXT, MD) e utiliza RAG (*Retrieval-Augmented Generation*) para responder perguntas baseadas nesse contexto, garantindo total privacidade dos dados e processamento acelerado por GPU no WSL 2.

⚠️ **Aviso de Laboratório (MVP Status)**  
Este projeto é um **Proof of Concept (PoC) / Laboratório**. Para manter a arquitetura simples e focar na funcionalidade de Streaming e RAG local, algumas concessões de design foram feitas nesta versão 1.0:
* O servidor Node.js é *Stateless* (não guarda sessão no backend).
* A memória de conversação (histórico) é gerenciada no frontend (`public/index.html`) e enviada no corpo da requisição a cada nova interação.
* *Em breve lançaremos a versão 2.0 com uma arquitetura corporativa, estado gerenciado no backend (Redis/Database), Dockerização completa e autenticação.*

## 🏗️ Arquitetura Lógica

* **Infraestrutura:** Windows 11 + WSL 2 (Ubuntu 24.04) com NVIDIA GPU Passthrough.
* **Inference Engine:** Ollama local (porta 11434).
* **Modelos:** `llama3.2` (LLM para inferência) e `nomic-embed-text` (Embeddings).
* **Backend:** Node.js v24 LTS (módulo `http` nativo, sem frameworks).
* **Banco Vetorial:** SQLite nativo (`alfred.db`) com a extensão `sqlite-vec` para cálculo de similaridade por cosseno.
* **Ingestão:** `pdf-parse@1.1.1` com fallback automático de OCR usando `tesseract.js` e `pdftoppm` nativo do Linux.
* **Frontend:** HTML/Vanilla JS com Server-Sent Events (SSE) para streaming da resposta e `Marked.js` para renderização de Markdown.

---

## 🚀 Como reproduzir este laboratório do zero

### 1. Preparação do Sistema Operacional (WSL 2 - Ubuntu)
Garanta que o seu WSL 2 esteja atualizado e instale as dependências nativas para compilação, rede e processamento de OCR:
```bash
sudo apt update && sudo apt install -y build-essential curl wget git net-tools iputils-ping tesseract-ocr tesseract-ocr-por poppler-utils jq
```

### 2. Instalação e Configuração do Motor de Inferência (Ollama)
Instale o Ollama via script oficial e faça o download dos modelos necessários para o cérebro e os embeddings:
```bash
curl -fsSL [https://ollama.com/install.sh](https://ollama.com/install.sh) | sh
ollama pull nomic-embed-text
ollama pull llama3.2
```

### 3. Instalação do Node.js (via NVM)
Baixe o NVM, recarregue o terminal e instale a versão LTS do Node.js:
```bash
curl -o- [https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh](https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh) | bash
source ~/.bashrc
nvm install --lts
```

### 4. Inicialização do Projeto e Dependências NPM
Crie o diretório do projeto, inicie o repositório e instale estritamente as bibliotecas validadas:
```bash
mkdir -p ~/projetos/alfred-1.0 && cd ~/projetos/alfred-1.0
npm init -y
npm install dotenv better-sqlite3 sqlite-vec pdf-parse@1.1.1 tesseract.js
```

---

## 📂 Criação dos Arquivos do Projeto

Crie os arquivos abaixo na raiz do diretório `~/projetos/alfred-1.0`. 

### `package.json`
```json
{
  "name": "alfred-mvp",
  "version": "1.0.0",
  "description": "Assistente Pessoal RAG 100% Local",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "ingest": "node ingest.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "dotenv": "^16.4.5",
    "pdf-parse": "^1.1.1",
    "sqlite-vec": "^0.1.1",
    "tesseract.js": "^5.1.1"
  }
}
```

### `.env.example`
```env
PORT=3000
APP_NAME="Alfred MVP"
NODE_ENV=development
OLLAMA_BASE_URL=[http://127.0.0.1:11434](http://127.0.0.1:11434)
```

### `.gitignore`
```text
node_modules/
.env
alfred.db
*.log
docs/*:Zone.Identifier
```

### `database.js`
```javascript
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const db = new Database('alfred.db');
sqliteVec.load(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conteudo TEXT NOT NULL,
    fonte TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS vetores_documentos USING vec0(
    documento_id INTEGER PRIMARY KEY,
    embedding float[768] distance_metric=cosine
  );
`);

function salvarDocumento(conteudo, fonte, vetor) {
  const inserirDoc = db.prepare('INSERT INTO documentos (conteudo, fonte) VALUES (?, ?)');
  const inserirVetor = db.prepare('INSERT INTO vetores_documentos (documento_id, embedding) VALUES (?, ?)');

  const transacao = db.transaction(() => {
    const info = inserirDoc.run(conteudo, fonte || 'manual');
    const docId = info.lastInsertRowid;
    inserirVetor.run(BigInt(docId), new Float32Array(vetor));
    return docId;
  });

  return transacao();
}

function buscarSimilares(vetorPergunta, limite = 4) {
  const query = db.prepare(`
    SELECT d.id, d.conteudo, d.fonte, v.distance
    FROM vetores_documentos v
    JOIN documentos d ON d.id = v.documento_id
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance ASC
  `);
  return query.all(new Float32Array(vetorPergunta), limite);
}

module.exports = { db, salvarDocumento, buscarSimilares };
```

### `embeddings.js`
```javascript
const ollamaUrl = process.env.OLLAMA_BASE_URL || '[http://127.0.0.1:11434](http://127.0.0.1:11434)';

async function gerarEmbedding(texto) {
  if (!texto || typeof texto !== 'string') {
    throw new Error('O texto para gerar embedding não pode estar vazio.');
  }
  const resposta = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: texto })
  });

  if (!resposta.ok) {
    throw new Error(`Falha no Ollama Embeddings: ${resposta.statusText}`);
  }

  const dados = await resposta.json();
  return dados.embedding;
}

module.exports = { gerarEmbedding };
```

### `ingest.js`
```javascript
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pdf = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const { gerarEmbedding } = require('./embeddings');
const { salvarDocumento } = require('./database');

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
    if (chunk.length > 50) chunks.push(chunk);
    inicio += tamanho - overlap;
  }
  return chunks;
}

async function extrairTextoViaOcr(caminhoPdf) {
  console.log(`    ↳ [OCR] Iniciando extração óptica para: ${path.basename(caminhoPdf)}...`);
  const pastaTemp = path.join(__dirname, 'temp_ocr');
  if (!fs.existsSync(pastaTemp)) fs.mkdirSync(pastaTemp, { recursive: true });

  const prefixoSaida = path.join(pastaTemp, 'pag');
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
    fs.unlinkSync(imagem);
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
      console.log(`    ⚠️ Pouco texto nativo detectado. Ativando fallback para OCR...`);
      texto = await extrairTextoViaOcr(caminhoArquivo);
    }
  } else if (caminhoArquivo.endsWith('.txt') || caminhoArquivo.endsWith('.md')) {
    texto = fs.readFileSync(caminhoArquivo, 'utf-8');
  } else {
    console.log(`    ⏩ Formato ignorado: ${nomeArquivo}`);
    return;
  }

  if (!texto || texto.trim().length < 50) return;

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
    console.log(`Criada a pasta '${PASTA_ENTRADA}'. Deposite seus arquivos nela.`);
    return;
  }

  const arquivos = fs.readdirSync(PASTA_ENTRADA);
  if (arquivos.length === 0) return;

  console.log(`=== Iniciando Pipeline de Ingestão do Alfred ===`);
  for (const arquivo of arquivos) {
    const caminhoCompleto = path.join(PASTA_ENTRADA, arquivo);
    if (fs.statSync(caminhoCompleto).isFile()) {
      try { await processarArquivo(caminhoCompleto); } 
      catch (err) { console.error(`    ❌ Erro:`, err.message); }
    }
  }
  console.log('\n=== Ingestão concluída com sucesso! ===');
}

iniciarIngestao();
```

### `index.js`
```javascript
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { gerarEmbedding } = require('./embeddings');
const { salvarDocumento, buscarSimilares } = require('./database');

const port = process.env.PORT || 3000;
const appName = process.env.APP_NAME || 'Alfred MVP';
const ollamaUrl = process.env.OLLAMA_BASE_URL || '[http://127.0.0.1:11434](http://127.0.0.1:11434)';

const server = http.createServer(async (req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Erro: Arquivo index.html não encontrado na pasta public.');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      }
    });
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  if (req.url === '/ask' && req.method === 'POST') {
    let corpo = '';
    req.on('data', chunk => { corpo += chunk; });
    
    req.on('end', async () => {
      try {
        const { pergunta, historico = [] } = JSON.parse(corpo);
        if (!pergunta) {
          res.writeHead(400);
          res.end(JSON.stringify({ erro: 'O campo "pergunta" é obrigatório.' }));
          return;
        }

        const vetorPergunta = await gerarEmbedding(pergunta);
        const trechosRelevantes = buscarSimilares(vetorPergunta, 4);
        
        const contextoTexto = trechosRelevantes
          .map((t, idx) => `[Documento ${idx + 1} | Fonte: ${t.fonte}]: ${t.conteudo}`)
          .join('\n\n');

        const historicoFormatado = historico
          .map(msg => `${msg.role === 'user' ? 'Usuário' : 'Alfred'}: ${msg.content}`)
          .join('\n');

        const promptFinal = `Você é o Alfred, assistente pessoal e técnico de infraestrutura.
Sua missão é responder à pergunta do usuário utilizando as informações contidas no contexto abaixo.

--- CONTEXTO RECUPERADO ---
${contextoTexto}
---------------------------

--- HISTÓRICO RECENTE DA CONVERSA ---
${historicoFormatado}
---------------------------

Usuário: ${pergunta}
Resposta:`;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        const respIa = await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama3.2',
            prompt: promptFinal,
            stream: true 
          })
        });

        if (!respIa.ok) throw new Error(`Erro no Ollama: ${respIa.statusText}`);

        const decoder = new TextDecoder('utf-8');
        let bufferStream = '';

        for await (const chunk of respIa.body) {
          bufferStream += decoder.decode(chunk, { stream: true });
          const linhas = bufferStream.split('\n');
          bufferStream = linhas.pop();
          
          for (const linha of linhas) {
            if (linha.trim() === '') continue;
            const jsonOllama = JSON.parse(linha);
            res.write(`data: ${JSON.stringify({ text: jsonOllama.response })}\n\n`);
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();

      } catch (err) {
        console.error('[ERRO /ask]', err.message);
        res.write(`data: ${JSON.stringify({ erro: err.message })}\n\n`);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ erro: 'Rota não encontrada' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[HTTP] ${appName} rodando em: [http://0.0.0.0](http://0.0.0.0):${port}`);
});
```

### `public/index.html`
Crie a pasta `public` (`mkdir public`) e adicione a interface responsiva:
```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>Alfred - Assistente Pessoal</title>
    <script src="[https://cdn.jsdelivr.net/npm/marked/marked.min.js](https://cdn.jsdelivr.net/npm/marked/marked.min.js)"></script>
    <style>
        body { font-family: system-ui; max-width: 800px; margin: 2rem auto; padding: 1rem; background: #1e1e1e; color: #eee; }
        #chat { height: 500px; overflow-y: auto; background: #2d2d2d; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
        .msg { margin-bottom: 1rem; padding: 0.8rem; border-radius: 6px; }
        .user { background: #005f9e; align-self: flex-end; }
        .alfred { background: #444; border-left: 4px solid #10b981; }
        pre { background: #111; padding: 10px; border-radius: 6px; overflow-x: auto; border: 1px solid #333; }
        code { font-family: 'Courier New', Courier, monospace; background: #111; padding: 2px 5px; border-radius: 4px; color: #10b981; }
        pre code { padding: 0; background: transparent; color: #e5e5e5; }
        input { width: calc(100% - 90px); padding: 0.8rem; border-radius: 4px; border: 1px solid #555; background: #333; color: white; }
        button { padding: 0.8rem; border-radius: 4px; border: none; background: #10b981; color: white; cursor: pointer; font-weight: bold; }
    </style>
</head>
<body>
    <h2>🦇 Alfred</h2>
    <div id="chat"></div>
    <div style="display: flex; gap: 10px;">
        <input type="text" id="prompt" placeholder="Pergunte algo..." onkeypress="if(event.key === 'Enter') send()">
        <button onclick="send()">Enviar</button>
    </div>

    <script>
        let memoriaConversa = [];

        async function send() {
            const input = document.getElementById('prompt');
            const chat = document.getElementById('chat');
            const text = input.value.trim();
            if (!text) return;

            chat.innerHTML += `<div class="msg user"><b>Você:</b> ${text}</div>`;
            input.value = '';

            const alfredDiv = document.createElement('div');
            alfredDiv.className = 'msg alfred';
            alfredDiv.innerHTML = '<b>Alfred:</b> <div class="content"></div>';
            chat.appendChild(alfredDiv);
            const contentDiv = alfredDiv.querySelector('.content');

            let textoAcumulado = '';

            try {
                const response = await fetch('/ask', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        pergunta: text, 
                        historico: memoriaConversa.slice(-6) 
                    })
                });

                if (!response.ok) {
                    const errData = await response.json();
                    contentDiv.innerHTML = `<span style="color: #ff6b6b;">[Erro: ${errData.erro || response.statusText}]</span>`;
                    return;
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunkString = decoder.decode(value, { stream: true });
                    const lines = chunkString.split('\n');

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.replace('data: ', '').trim();
                            if (data === '[DONE]') break;
                            
                            try {
                                const json = JSON.parse(data);
                                if (json.text) {
                                    textoAcumulado += json.text;
                                    contentDiv.innerHTML = marked.parse(textoAcumulado);
                                    chat.scrollTop = chat.scrollHeight;
                                } else if (json.erro) {
                                    contentDiv.innerHTML += `<br><span style="color: #ff6b6b;">[Falha: ${json.erro}]</span>`;
                                }
                            } catch (e) {}
                        }
                    }
                }

                memoriaConversa.push({ role: 'user', content: text });
                memoriaConversa.push({ role: 'alfred', content: textoAcumulado });

            } catch (error) {
                contentDiv.innerHTML = `<span style="color: #ff6b6b;">[Erro de conexão com o servidor local]</span>`;
            }
        }
    </script>
</body>
</html>
```

---

## 🏃 Como rodar o projeto

### 1. Execute a ingestão dos seus arquivos
Crie a pasta `docs` na raiz do projeto e coloque seus arquivos lá dentro (`.pdf`, `.txt`, `.md`). Depois, no terminal, processe-os:
```bash
npm run ingest
```
*Se houver arquivos com identificadores de zona herdados do Windows, rode `rm -f docs/*:Zone.Identifier` antes.*

### 2. Inicie o servidor
Suba a API e o Client HTML no WSL:
```bash
npm run dev
```

### 3. Acesse a interface web
Abra o navegador no Windows e acesse:
`http://localhost:3000`

---
*Desenvolvido por Alexandre Neves - Virtualization Tech Lead & Solutions Architect.*