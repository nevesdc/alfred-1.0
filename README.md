\# 🦇 Alfred 1.0 - Local RAG Assistant MVP



O \*\*Alfred\*\* é um assistente pessoal de IA construído 100% localmente, projetado para atuar como um "Segundo Cérebro" técnico. Ele ingere documentos (PDFs, TXT, MD) e utiliza RAG (\*Retrieval-Augmented Generation\*) para responder perguntas baseadas nesse contexto, garantindo total privacidade dos dados e processamento acelerado por GPU no WSL 2.



⚠️ \*\*Aviso de Laboratório (MVP Status)\*\*  

Este projeto é um \*\*Proof of Concept (PoC) / Laboratório\*\*. Para manter a arquitetura simples e focar na funcionalidade de Streaming e RAG local, algumas concessões de design foram feitas nesta versão 1.0:

\* O servidor Node.js é \*Stateless\* (não guarda sessão no backend).

\* A memória de conversação (histórico) é gerenciada no frontend (`public/index.html`) e enviada no corpo da requisição a cada nova interação.

\* \*Em breve lançaremos a versão 2.0 com uma arquitetura corporativa, estado gerenciado no backend (Redis/Database), Dockerização completa e autenticação.\*



\## 🏗️ Arquitetura Lógica



\* \*\*Infraestrutura:\*\* Windows 11 + WSL 2 (Ubuntu 24.04) com NVIDIA GPU Passthrough.

\* \*\*Inference Engine:\*\* Ollama local (porta 11434).

\* \*\*Modelos:\*\* `llama3.2` (LLM para inferência) e `nomic-embed-text` (Embeddings).

\* \*\*Backend:\*\* Node.js v24 LTS (módulo `http` nativo, sem frameworks).

\* \*\*Banco Vetorial:\*\* SQLite nativo (`alfred.db`) com a extensão `sqlite-vec` para cálculo de similaridade por cosseno.

\* \*\*Ingestão:\*\* `pdf-parse@1.1.1` com fallback automático de OCR usando `tesseract.js` e `pdftoppm` nativo do Linux.

\* \*\*Frontend:\*\* HTML/Vanilla JS com Server-Sent Events (SSE) para streaming da resposta e `Marked.js` para renderização de Markdown.



\---



\## 🚀 Como reproduzir este laboratório do zero



\### 1. Preparação do Sistema Operacional (WSL 2 - Ubuntu)

Garanta que o seu WSL 2 esteja atualizado e instale as dependências nativas para compilação, rede e processamento de OCR:

```bash

sudo apt update \&\& sudo apt install -y build-essential curl wget git net-tools iputils-ping tesseract-ocr tesseract-ocr-por poppler-utils jq

```



\### 2. Instalação e Configuração do Motor de Inferência (Ollama)

Instale o Ollama via script oficial e faça o download dos modelos necessários para o cérebro e os embeddings:

```bash

curl -fsSL \[https://ollama.com/install.sh](https://ollama.com/install.sh) | sh

ollama pull nomic-embed-text

ollama pull llama3.2

```



\### 3. Instalação do Node.js (via NVM)

Baixe o NVM, recarregue o terminal e instale a versão LTS do Node.js:

```bash

curl -o- \[https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh](https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh) | bash

source \~/.bashrc

nvm install --lts

```



\### 4. Inicialização do Projeto e Dependências NPM

Crie o diretório do projeto, inicie o repositório e instale estritamente as bibliotecas validadas:

```bash

mkdir -p \~/projetos/alfred-1.0 \&\& cd \~/projetos/alfred-1.0

npm init -y

npm install dotenv better-sqlite3 sqlite-vec pdf-parse@1.1.1 tesseract.js

```



\---



\## 📂 Criação dos Arquivos do Projeto



Crie os arquivos abaixo na raiz do diretório `\~/projetos/alfred-1.0`. 



\### `package.json`

Substitua o conteúdo gerado pelo `npm init` por este bloco para mapear os scripts de inicialização e ingestão:

```json

{

&#x20; "name": "alfred-mvp",

&#x20; "version": "1.0.0",

&#x20; "description": "Assistente Pessoal RAG 100% Local",

&#x20; "main": "index.js",

&#x20; "scripts": {

&#x20;   "start": "node index.js",

&#x20;   "dev": "node --watch index.js",

&#x20;   "ingest": "node ingest.js"

&#x20; },

&#x20; "dependencies": {

&#x20;   "better-sqlite3": "^11.3.0",

&#x20;   "dotenv": "^16.4.5",

&#x20;   "pdf-parse": "^1.1.1",

&#x20;   "sqlite-vec": "^0.1.1",

&#x20;   "tesseract.js": "^5.1.1"

&#x20; }

}

```



\### `.env`

Contém as variáveis do servidor:

```env

PORT=3000

APP\_NAME="Alfred MVP"

NODE\_ENV=development

OLLAMA\_BASE\_URL=\[http://127.0.0.1:11434](http://127.0.0.1:11434)

```



\### `.gitignore`

Protege o repositório de binários e credenciais:

```text

node\_modules/

.env

alfred.db

\*.log

docs/\*:Zone.Identifier

```



\### `database.js`

Responsável pela persistência e criação da tabela virtual de 768 dimensões:

```javascript

const Database = require('better-sqlite3');

const sqliteVec = require('sqlite-vec');



const db = new Database('alfred.db');

sqliteVec.load(db);



db.exec(`

&#x20; CREATE TABLE IF NOT EXISTS documentos (

&#x20;   id INTEGER PRIMARY KEY AUTOINCREMENT,

&#x20;   conteudo TEXT NOT NULL,

&#x20;   fonte TEXT,

&#x20;   criado\_em DATETIME DEFAULT CURRENT\_TIMESTAMP

&#x20; );

`);



db.exec(`

&#x20; CREATE VIRTUAL TABLE IF NOT EXISTS vetores\_documentos USING vec0(

&#x20;   documento\_id INTEGER PRIMARY KEY,

&#x20;   embedding float\[768] distance\_metric=cosine

&#x20; );

`);



function salvarDocumento(conteudo, fonte, vetor) {

&#x20; const inserirDoc = db.prepare('INSERT INTO documentos (conteudo, fonte) VALUES (?, ?)');

&#x20; const inserirVetor = db.prepare('INSERT INTO vetores\_documentos (documento\_id, embedding) VALUES (?, ?)');



&#x20; const transacao = db.transaction(() => {

&#x20;   const info = inserirDoc.run(conteudo, fonte || 'manual');

&#x20;   const docId = info.lastInsertRowid;

&#x20;   inserirVetor.run(BigInt(docId), new Float32Array(vetor));

&#x20;   return docId;

&#x20; });



&#x20; return transacao();

}



function buscarSimilares(vetorPergunta, limite = 4) {

&#x20; const query = db.prepare(`

&#x20;   SELECT d.id, d.conteudo, d.fonte, v.distance

&#x20;   FROM vetores\_documentos v

&#x20;   JOIN documentos d ON d.id = v.documento\_id

&#x20;   WHERE v.embedding MATCH ? AND k = ?

&#x20;   ORDER BY v.distance ASC

&#x20; `);

&#x20; return query.all(new Float32Array(vetorPergunta), limite);

}



module.exports = { db, salvarDocumento, buscarSimilares };

```



\### `embeddings.js`

Ponte de integração matemática com o Ollama:

```javascript

const ollamaUrl = process.env.OLLAMA\_BASE\_URL || '\[http://127.0.0.1:11434](http://127.0.0.1:11434)';



async function gerarEmbedding(texto) {

&#x20; if (!texto || typeof texto !== 'string') {

&#x20;   throw new Error('O texto para gerar embedding não pode estar vazio.');

&#x20; }

&#x20; const resposta = await fetch(`${ollamaUrl}/api/embeddings`, {

&#x20;   method: 'POST',

&#x20;   headers: { 'Content-Type': 'application/json' },

&#x20;   body: JSON.stringify({ model: 'nomic-embed-text', prompt: texto })

&#x20; });



&#x20; if (!resposta.ok) {

&#x20;   throw new Error(`Falha no Ollama Embeddings: ${resposta.statusText}`);

&#x20; }



&#x20; const dados = await resposta.json();

&#x20; return dados.embedding;

}



module.exports = { gerarEmbedding };

```



\### `ingest.js`

Pipeline híbrido de ingestão de documentos (leitura direta de PDF + OCR) com chunking e overlap:

```javascript

require('dotenv').config();

const fs = require('fs');

const path = require('path');

const { execSync } = require('child\_process');

const pdf = require('pdf-parse');

const { createWorker } = require('tesseract.js');

const { gerarEmbedding } = require('./embeddings');

const { salvarDocumento } = require('./database');



const PASTA\_ENTRADA = path.join(\_\_dirname, 'docs');

const CHUNK\_SIZE = 800;

const CHUNK\_OVERLAP = 150;



function dividirEmChunks(texto, tamanho = CHUNK\_SIZE, overlap = CHUNK\_OVERLAP) {

&#x20; const chunks = \[];

&#x20; let inicio = 0;

&#x20; const textoLimpo = texto.replace(/\\s+/g, ' ').trim();



&#x20; while (inicio < textoLimpo.length) {

&#x20;   const fim = Math.min(inicio + tamanho, textoLimpo.length);

&#x20;   const chunk = textoLimpo.slice(inicio, fim).trim();

&#x20;   if (chunk.length > 50) chunks.push(chunk);

&#x20;   inicio += tamanho - overlap;

&#x20; }

&#x20; return chunks;

}



async function extrairTextoViaOcr(caminhoPdf) {

&#x20; console.log(`    ↳ \[OCR] Iniciando extração óptica para: ${path.basename(caminhoPdf)}...`);

&#x20; const pastaTemp = path.join(\_\_dirname, 'temp\_ocr');

&#x20; if (!fs.existsSync(pastaTemp)) fs.mkdirSync(pastaTemp, { recursive: true });



&#x20; const prefixoSaida = path.join(pastaTemp, 'pag');

&#x20; execSync(`pdftoppm -png -r 150 "${caminhoPdf}" "${prefixoSaida}"`);



&#x20; const arquivosImagens = fs.readdirSync(pastaTemp)

&#x20;   .filter(arq => arq.startsWith('pag-') \&\& arq.endsWith('.png'))

&#x20;   .sort()

&#x20;   .map(arq => path.join(pastaTemp, arq));



&#x20; const worker = await createWorker('por');

&#x20; let textoTotal = '';



&#x20; for (const imagem of arquivosImagens) {

&#x20;   const ret = await worker.recognize(imagem);

&#x20;   textoTotal += `\\n${ret.data.text}`;

&#x20;   fs.unlinkSync(imagem);

&#x20; }



&#x20; await worker.terminate();

&#x20; return textoTotal;

}



async function processarArquivo(caminhoArquivo) {

&#x20; const nomeArquivo = path.basename(caminhoArquivo);

&#x20; console.log(`\\n📄 Processando: ${nomeArquivo}`);

&#x20; let texto = '';



&#x20; if (caminhoArquivo.endsWith('.pdf')) {

&#x20;   const buffer = fs.readFileSync(caminhoArquivo);

&#x20;   const dadosPdf = await pdf(buffer);

&#x20;   texto = dadosPdf.text ? dadosPdf.text.trim() : '';



&#x20;   if (texto.length < 100) {

&#x20;     console.log(`    ⚠️ Pouco texto nativo detectado. Ativando fallback para OCR...`);

&#x20;     texto = await extrairTextoViaOcr(caminhoArquivo);

&#x20;   }

&#x20; } else if (caminhoArquivo.endsWith('.txt') || caminhoArquivo.endsWith('.md')) {

&#x20;   texto = fs.readFileSync(caminhoArquivo, 'utf-8');

&#x20; } else {

&#x20;   console.log(`    ⏩ Formato ignorado: ${nomeArquivo}`);

&#x20;   return;

&#x20; }



&#x20; if (!texto || texto.trim().length < 50) return;



&#x20; const blocos = dividirEmChunks(texto);

&#x20; console.log(`    ✂️ Texto dividido em ${blocos.length} chunks. Gerando embeddings...`);



&#x20; for (let i = 0; i < blocos.length; i++) {

&#x20;   const trecho = blocos\[i];

&#x20;   const vetor = await gerarEmbedding(trecho);

&#x20;   salvarDocumento(trecho, `${nomeArquivo} (parte ${i + 1}/${blocos.length})`, vetor);

&#x20;   process.stdout.write(`    ⚡ Chunk ${i + 1}/${blocos.length} indexado no SQLite\\r`);

&#x20; }

&#x20; console.log(`\\n    ✅ ${nomeArquivo} totalmente indexado na base do Alfred!`);

}



async function iniciarIngestao() {

&#x20; if (!fs.existsSync(PASTA\_ENTRADA)) {

&#x20;   fs.mkdirSync(PASTA\_ENTRADA, { recursive: true });

&#x20;   console.log(`Criada a pasta '${PASTA\_ENTRADA}'. Deposite seus arquivos nela.`);

&#x20;   return;

&#x20; }



&#x20; const arquivos = fs.readdirSync(PASTA\_ENTRADA);

&#x20; if (arquivos.length === 0) return;



&#x20; console.log(`=== Iniciando Pipeline de Ingestão do Alfred ===`);

&#x20; for (const arquivo of arquivos) {

&#x20;   const caminhoCompleto = path.join(PASTA\_ENTRADA, arquivo);

&#x20;   if (fs.statSync(caminhoCompleto).isFile()) {

&#x20;     try { await processarArquivo(caminhoCompleto); } 

&#x20;     catch (err) { console.error(`    ❌ Erro:`, err.message); }

&#x20;   }

&#x20; }

&#x20; console.log('\\n=== Ingestão concluída com sucesso! ===');

}



iniciarIngestao();

```



\### `index.js`

O servidor HTTP puro orquestrando o fluxo do RAG, servindo a web e administrando o Streaming:

```javascript

require('dotenv').config();

const http = require('http');

const fs = require('fs');

const path = require('path');

const { gerarEmbedding } = require('./embeddings');

const { salvarDocumento, buscarSimilares } = require('./database');



const port = process.env.PORT || 3000;

const appName = process.env.APP\_NAME || 'Alfred MVP';

const ollamaUrl = process.env.OLLAMA\_BASE\_URL || '\[http://127.0.0.1:11434](http://127.0.0.1:11434)';



const server = http.createServer(async (req, res) => {

&#x20; if (req.url === '/' \&\& req.method === 'GET') {

&#x20;   const filePath = path.join(\_\_dirname, 'public', 'index.html');

&#x20;   fs.readFile(filePath, (err, content) => {

&#x20;     if (err) {

&#x20;       res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });

&#x20;       res.end('Erro: Arquivo index.html não encontrado na pasta public.');

&#x20;     } else {

&#x20;       res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

&#x20;       res.end(content);

&#x20;     }

&#x20;   });

&#x20;   return;

&#x20; }



&#x20; res.setHeader('Content-Type', 'application/json; charset=utf-8');



&#x20; if (req.url === '/health' \&\& req.method === 'GET') {

&#x20;   res.writeHead(200);

&#x20;   res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));

&#x20;   return;

&#x20; }



&#x20; if (req.url === '/ask' \&\& req.method === 'POST') {

&#x20;   let corpo = '';

&#x20;   req.on('data', chunk => { corpo += chunk; });

&#x20;   

&#x20;   req.on('end', async () => {

&#x20;     try {

&#x20;       const { pergunta, historico = \[] } = JSON.parse(corpo);

&#x20;       if (!pergunta) {

&#x20;         res.writeHead(400);

&#x20;         res.end(JSON.stringify({ erro: 'O campo "pergunta" é obrigatório.' }));

&#x20;         return;

&#x20;       }



&#x20;       const vetorPergunta = await gerarEmbedding(pergunta);

&#x20;       const trechosRelevantes = buscarSimilares(vetorPergunta, 4);

&#x20;       

&#x20;       const contextoTexto = trechosRelevantes

&#x20;         .map((t, idx) => `\[Documento ${idx + 1} | Fonte: ${t.fonte}]: ${t.conteudo}`)

&#x20;         .join('\\n\\n');



&#x20;       const historicoFormatado = historico

&#x20;         .map(msg => `${msg.role === 'user' ? 'Usuário' : 'Alfred'}: ${msg.content}`)

&#x20;         .join('\\n');



&#x20;       const promptFinal = `Você é o Alfred, assistente pessoal e técnico de infraestrutura.

Sua missão é responder à pergunta do usuário utilizando as informações contidas no contexto abaixo.



\--- CONTEXTO RECUPERADO ---

${contextoTexto}

\---------------------------



\--- HISTÓRICO RECENTE DA CONVERSA ---

${historicoFormatado}

\---------------------------



Usuário: ${pergunta}

Resposta:`;



&#x20;       res.writeHead(200, {

&#x20;         'Content-Type': 'text/event-stream; charset=utf-8',

&#x20;         'Cache-Control': 'no-cache',

&#x20;         'Connection': 'keep-alive'

&#x20;       });



&#x20;       const respIa = await fetch(`${ollamaUrl}/api/generate`, {

&#x20;         method: 'POST',

&#x20;         headers: { 'Content-Type': 'application/json' },

&#x20;         body: JSON.stringify({

&#x20;           model: 'llama3.2',

&#x20;           prompt: promptFinal,

&#x20;           stream: true 

&#x20;         })

&#x20;       });



&#x20;       if (!respIa.ok) throw new Error(`Erro no Ollama: ${respIa.statusText}`);



&#x20;       const decoder = new TextDecoder('utf-8');

&#x20;       let bufferStream = '';



&#x20;       for await (const chunk of respIa.body) {

&#x20;         bufferStream += decoder.decode(chunk, { stream: true });

&#x20;         const linhas = bufferStream.split('\\n');

&#x20;         bufferStream = linhas.pop();

&#x20;         

&#x20;         for (const linha of linhas) {

&#x20;           if (linha.trim() === '') continue;

&#x20;           const jsonOllama = JSON.parse(linha);

&#x20;           res.write(`data: ${JSON.stringify({ text: jsonOllama.response })}\\n\\n`);

&#x20;         }

&#x20;       }

&#x20;       res.write('data: \[DONE]\\n\\n');

&#x20;       res.end();



&#x20;     } catch (err) {

&#x20;       console.error('\[ERRO /ask]', err.message);

&#x20;       res.write(`data: ${JSON.stringify({ erro: err.message })}\\n\\n`);

&#x20;       res.end();

&#x20;     }

&#x20;   });

&#x20;   return;

&#x20; }



&#x20; res.writeHead(404);

&#x20; res.end(JSON.stringify({ erro: 'Rota não encontrada' }));

});



server.listen(port, '0.0.0.0', () => {

&#x20; console.log(`\[HTTP] ${appName} rodando em: \[http://0.0.0.0](http://0.0.0.0):${port}`);

});

```



\### `public/index.html`

Crie a pasta `public` (`mkdir public`) e adicione a interface responsiva:

```html

<!DOCTYPE html>

<html lang="pt-BR">

<head>

&#x20;   <meta charset="UTF-8">

&#x20;   <title>Alfred - Assistente Pessoal</title>

&#x20;   <script src="\[https://cdn.jsdelivr.net/npm/marked/marked.min.js](https://cdn.jsdelivr.net/npm/marked/marked.min.js)"></script>

&#x20;   <style>

&#x20;       body { font-family: system-ui; max-width: 800px; margin: 2rem auto; padding: 1rem; background: #1e1e1e; color: #eee; }

&#x20;       #chat { height: 500px; overflow-y: auto; background: #2d2d2d; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }

&#x20;       .msg { margin-bottom: 1rem; padding: 0.8rem; border-radius: 6px; }

&#x20;       .user { background: #005f9e; align-self: flex-end; }

&#x20;       .alfred { background: #444; border-left: 4px solid #10b981; }

&#x20;       pre { background: #111; padding: 10px; border-radius: 6px; overflow-x: auto; border: 1px solid #333; }

&#x20;       code { font-family: 'Courier New', Courier, monospace; background: #111; padding: 2px 5px; border-radius: 4px; color: #10b981; }

&#x20;       pre code { padding: 0; background: transparent; color: #e5e5e5; }

&#x20;       input { width: calc(100% - 90px); padding: 0.8rem; border-radius: 4px; border: 1px solid #555; background: #333; color: white; }

&#x20;       button { padding: 0.8rem; border-radius: 4px; border: none; background: #10b981; color: white; cursor: pointer; font-weight: bold; }

&#x20;   </style>

</head>

<body>

&#x20;   <h2>🦇 Alfred</h2>

&#x20;   <div id="chat"></div>

&#x20;   <div style="display: flex; gap: 10px;">

&#x20;       <input type="text" id="prompt" placeholder="Pergunte algo..." onkeypress="if(event.key === 'Enter') send()">

&#x20;       <button onclick="send()">Enviar</button>

&#x20;   </div>



&#x20;   <script>

&#x20;       let memoriaConversa = \[];



&#x20;       async function send() {

&#x20;           const input = document.getElementById('prompt');

&#x20;           const chat = document.getElementById('chat');

&#x20;           const text = input.value.trim();

&#x20;           if (!text) return;



&#x20;           chat.innerHTML += `<div class="msg user"><b>Você:</b> ${text}</div>`;

&#x20;           input.value = '';



&#x20;           const alfredDiv = document.createElement('div');

&#x20;           alfredDiv.className = 'msg alfred';

&#x20;           alfredDiv.innerHTML = '<b>Alfred:</b> <div class="content"></div>';

&#x20;           chat.appendChild(alfredDiv);

&#x20;           const contentDiv = alfredDiv.querySelector('.content');



&#x20;           let textoAcumulado = '';



&#x20;           try {

&#x20;               const response = await fetch('/ask', {

&#x20;                   method: 'POST',

&#x20;                   headers: { 'Content-Type': 'application/json' },

&#x20;                   body: JSON.stringify({ 

&#x20;                       pergunta: text, 

&#x20;                       historico: memoriaConversa.slice(-6) 

&#x20;                   })

&#x20;               });



&#x20;               if (!response.ok) {

&#x20;                   const errData = await response.json();

&#x20;                   contentDiv.innerHTML = `<span style="color: #ff6b6b;">\[Erro: ${errData.erro || response.statusText}]</span>`;

&#x20;                   return;

&#x20;               }



&#x20;               const reader = response.body.getReader();

&#x20;               const decoder = new TextDecoder('utf-8');



&#x20;               while (true) {

&#x20;                   const { done, value } = await reader.read();

&#x20;                   if (done) break;



&#x20;                   const chunkString = decoder.decode(value, { stream: true });

&#x20;                   const lines = chunkString.split('\\n');



&#x20;                   for (const line of lines) {

&#x20;                       if (line.startsWith('data: ')) {

&#x20;                           const data = line.replace('data: ', '').trim();

&#x20;                           if (data === '\[DONE]') break;

&#x20;                           

&#x20;                           try {

&#x20;                               const json = JSON.parse(data);

&#x20;                               if (json.text) {

&#x20;                                   textoAcumulado += json.text;

&#x20;                                   contentDiv.innerHTML = marked.parse(textoAcumulado);

&#x20;                                   chat.scrollTop = chat.scrollHeight;

&#x20;                               } else if (json.erro) {

&#x20;                                   contentDiv.innerHTML += `<br><span style="color: #ff6b6b;">\[Falha: ${json.erro}]</span>`;

&#x20;                               }

&#x20;                           } catch (e) {}

&#x20;                       }

&#x20;                   }

&#x20;               }



&#x20;               memoriaConversa.push({ role: 'user', content: text });

&#x20;               memoriaConversa.push({ role: 'alfred', content: textoAcumulado });



&#x20;           } catch (error) {

&#x20;               contentDiv.innerHTML = `<span style="color: #ff6b6b;">\[Erro de conexão com o servidor local]</span>`;

&#x20;           }

&#x20;       }

&#x20;   </script>

</body>

</html>

```



\---



\## 🏃 Como rodar o projeto



\### 1. Execute a ingestão dos seus arquivos

Crie a pasta `docs` na raiz do projeto e coloque seus arquivos lá dentro (`.pdf`, `.txt`, `.md`). Depois, no terminal, processe-os:

```bash

npm run ingest

```

\*Se houver arquivos com identificadores de zona herdados do Windows, rode `rm -f docs/\*:Zone.Identifier` antes.\*



\### 2. Inicie o servidor

Suba a API e o Client HTML no WSL:

```bash

npm run dev

```



\### 3. Acesse a interface web

Abra o navegador no Windows e acesse:

`http://localhost:3000`



\---

\*Desenvolvido por Alexandre Neves - Solutions Architect com conhecimentos técnicos e arquiteturais avançados.\*

