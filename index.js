require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { gerarEmbedding } = require('./embeddings');
const { salvarDocumento, buscarSimilares } = require('./database');

const port = process.env.PORT || 3000;
const appName = process.env.APP_NAME || 'Alfred MVP';
const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

const server = http.createServer(async (req, res) => {
  // ---------------------------------------------------------
  // Servir a interface web (HTML)
  // ---------------------------------------------------------
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

  // Configura cabeçalho padrão para respostas JSON em UTF-8
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // 1. Health Check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // 2. Ingestão de Documentos: POST /documents
  if (req.url === '/documents' && req.method === 'POST') {
    let corpo = '';
    req.on('data', (chunk) => { corpo += chunk; });

    req.on('end', async () => {
      try {
        const { conteudo, fonte } = JSON.parse(corpo);
        if (!conteudo) {
          res.writeHead(400);
          res.end(JSON.stringify({ erro: 'O campo "conteudo" é obrigatório.' }));
          return;
        }

        const vetor = await gerarEmbedding(conteudo);
        const id = salvarDocumento(conteudo, fonte, vetor);

        res.writeHead(201);
        res.end(JSON.stringify({ mensagem: 'Documento indexado com sucesso!', id }));
      } catch (err) {
        console.error('[ERRO /documents]', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ erro: err.message }));
      }
    });
    return;
  }

  // 3. Busca Semântica Pura: POST /search
  if (req.url === '/search' && req.method === 'POST') {
    let corpo = '';
    req.on('data', (chunk) => { corpo += chunk; });

    req.on('end', async () => {
      try {
        const { consulta, limite } = JSON.parse(corpo);
        if (!consulta) {
          res.writeHead(400);
          res.end(JSON.stringify({ erro: 'O campo "consulta" é obrigatório.' }));
          return;
        }

        const vetorConsulta = await gerarEmbedding(consulta);
        const resultados = buscarSimilares(vetorConsulta, limite || 3);

        res.writeHead(200);
        res.end(JSON.stringify({ consulta, resultados }));
      } catch (err) {
        console.error('[ERRO /search]', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ erro: err.message }));
      }
    });
    return;
  }

  // 4. RAG Completo com STREAMING e MEMÓRIA: POST /ask
  if (req.url === '/ask' && req.method === 'POST') {
    let corpo = '';
    req.on('data', (chunk) => { corpo += chunk; });
    
    req.on('end', async () => {
      try {
        // Recebe a pergunta e o histórico do frontend
        const { pergunta, historico = [] } = JSON.parse(corpo);
        
        if (!pergunta) {
          res.writeHead(400);
          res.end(JSON.stringify({ erro: 'O campo "pergunta" é obrigatório.' }));
          return;
        }

        // 1. Busca os dados no SQLite
        const vetorPergunta = await gerarEmbedding(pergunta);
        const trechosRelevantes = buscarSimilares(vetorPergunta, 4);
        
        const contextoTexto = trechosRelevantes
          .map((t, idx) => `[Documento ${idx + 1} | Fonte: ${t.fonte}]: ${t.conteudo}`)
          .join('\n\n');

        // 2. Formata o histórico recebido para que o modelo entenda quem falou o quê
        const historicoFormatado = historico
          .map(msg => `${msg.role === 'user' ? 'Usuário' : 'Alfred'}: ${msg.content}`)
          .join('\n');

        // 3. Monta o novo prompt com o contexto e a memória injetada
        const promptFinal = `Você é o Alfred, assistente pessoal e de infraestrutura.
Sua missão é responder à pergunta do usuário utilizando as informações contidas no contexto abaixo.

Regras de comportamento:
1. Se a mensagem do usuário for apenas uma saudação (como "olá", "bom dia", "tudo bem?") ou uma conversa informal, responda de forma natural, curta e educada. IGNORE o contexto.
2. Se a mensagem for uma pergunta ou pedido técnico, baseie sua resposta ESTRITAMENTE nas informações do "Contexto Recuperado".
3. Se a informação solicitada não estiver no contexto, diga educadamente que não possui essa informação na base.

--- CONTEXTO RECUPERADO ---
${contextoTexto}
---------------------------

--- HISTÓRICO RECENTE DA CONVERSA ---
${historicoFormatado}
---------------------------

Usuário: ${pergunta}
Resposta:`;

        // 4. Prepara os cabeçalhos HTTP para Streaming (Server-Sent Events)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        // 5. Consulta o Ollama ativando o stream
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

// 6. Lê o stream de resposta e repassa ao frontend (Com Buffering)
        const decoder = new TextDecoder('utf-8');
        let bufferStream = '';

        for await (const chunk of respIa.body) {
          bufferStream += decoder.decode(chunk, { stream: true });
          
          // Divide a string onde houver quebras de linha
          const linhas = bufferStream.split('\n');
          
          // O último elemento será uma string vazia (se terminou perfeitamente em \n)
          // ou um JSON incompleto. Retiramos da iteração e devolvemos ao buffer.
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

  // Rota não encontrada
  res.writeHead(404);
  res.end(JSON.stringify({ erro: 'Rota não encontrada' }));
});

// Substitua as linhas finais do server.listen por:
server.listen(port, '0.0.0.0', () => {
  console.log(`[HTTP] ${appName} rodando na porta:${port}`);
  console.log(`[AI] Conectado ao Ollama em: ${ollamaUrl}`);
});
