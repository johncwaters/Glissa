import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from '../scripts/command-line.mjs';

const bufferApiUrl = 'https://api.buffer.com';
const bufferPostIdPattern = /^[a-f\d]{24}$/;
const authorizationHeaderPattern = /^authorization:\s*(bearer\s+\S+)\s*$/im;
const postNotFoundPattern = /^Post not found for id/;
const postStateQuery = 'query PostState($id: PostId!) { post(input: { id: $id }) { id status updatedAt } }';

function readAuthorizationHeader() {
  const headerFileText = readFileSync(join(homedir(), '.config', 'glissa', 'buffer-headers.txt'), 'utf8');
  const headerMatch = authorizationHeaderPattern.exec(headerFileText);
  if (!headerMatch) throw new Error('No Authorization header in the Buffer header file');
  return headerMatch[1];
}

export async function readPostState(postId, { fetchPost = fetch, readAuthorization = readAuthorizationHeader } = {}) {
  const response = await fetchPost(bufferApiUrl, {
    method: 'POST',
    headers: { Authorization: readAuthorization(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: postStateQuery, variables: { id: postId } }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Buffer answered ${response.status}`);
  const { data, errors } = await response.json();
  const isPostMissing = Array.isArray(errors) && errors.some((error) => postNotFoundPattern.test(error?.message ?? ''));
  if (isPostMissing) return { missing: true };
  if (typeof data?.post?.status !== 'string' || typeof data.post.updatedAt !== 'string') throw new Error('Buffer post state unreadable');
  return { status: data.post.status, updatedAt: data.post.updatedAt };
}

if (isMainModule(import.meta.url)) {
  const [postId] = process.argv.slice(2);
  if (!bufferPostIdPattern.test(postId ?? '')) {
    process.stderr.write('Usage: buffer-post-state.mjs <postId>\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(await readPostState(postId))}\n`);
}
