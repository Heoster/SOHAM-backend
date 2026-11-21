/** Read-only Pinecone setup check; never provisions or modifies an index. */
import { pineconeRequest } from '../memory/pinecone-vector';
pineconeRequest('/describe_index_stats', {}).then(stats => {
  console.log('Pinecone connection OK. Index dimension:', stats.dimension);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
