const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

/**
 * Envia um texto para o nomic-embed-text e retorna o array de números (vetor).
 * @param {string} texto
 * @returns {Promise<number[]>}
 */
async function gerarEmbedding(texto) {
  if (!texto || typeof texto !== 'string') {
    throw new Error('O texto para gerar embedding não pode estar vazio.');
  }

  const resposta = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'nomic-embed-text',
      prompt: texto
    })
  });

  if (!resposta.ok) {
    throw new Error(`Falha no Ollama Embeddings: ${resposta.statusText}`);
  }

  const dados = await resposta.json();
  return dados.embedding; // Array de floats (tamanho 768)
}

module.exports = { gerarEmbedding };
