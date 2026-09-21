const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

// Abre ou cria o arquivo de banco alfred.db na pasta do projeto
const db = new Database('alfred.db');

// Carrega a extensão sqlite-vec no motor SQLite
sqliteVec.load(db);

// 1. Tabela relacional para os textos
db.exec(`
  CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conteudo TEXT NOT NULL,
    fonte TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 2. Tabela virtual vetorial para busca semântica (768 dimensões)
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

function buscarSimilares(vetorPergunta, limite = 3) {
  const query = db.prepare(`
    SELECT 
      d.id,
      d.conteudo,
      d.fonte,
      v.distance
    FROM vetores_documentos v
    JOIN documentos d ON d.id = v.documento_id
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance ASC
  `);

  return query.all(new Float32Array(vetorPergunta), limite);
}

module.exports = { db, salvarDocumento, buscarSimilares };
