import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../infrastructure/cloudfront/block-crawlers.js', import.meta.url), 'utf8');
const scope = vm.createContext({});
vm.runInContext(source, scope);
const agents = ['Googlebot', 'bingbot', 'Baiduspider', 'YandexBot', 'DuckDuckBot', 'Applebot', 'Bytespider', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'GoogleOther', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'CCBot', 'Amazonbot', 'meta-externalagent', 'meta-externalfetcher'];
function request(agent, uri = '/') {
  return {uri, method: 'GET', headers: agent ? {'user-agent': {value: agent}} : {}};
}

test('viewer-request rejects recognized crawlers before any cached content is returned', () => {
  for (const agent of agents) for (const uri of ['/', '/index.html', '/runtime-config.json', '/assets/example.js', '/missing']) {
    const response = scope.handler({request: request(agent, uri)});
    assert.equal(response.statusCode, 403, agent);
    assert.equal(response.headers['cache-control'].value, 'no-store');
    assert.match(response.headers['x-robots-tag'].value, /noindex/);
  }
});

test('robots policy remains available and ordinary browser requests are unchanged', () => {
  for (const agent of agents) {
    const value = request(agent, '/robots.txt');
    assert.equal(scope.handler({request: value}), value);
  }
  for (const agent of [undefined, 'Mozilla/5.0 Chrome/145.0.0.0 Safari/537.36', 'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15']) {
    const value = request(agent);
    assert.equal(scope.handler({request: value}), value);
  }
  const robots = readFileSync(new URL('../web/public/robots.txt', import.meta.url), 'utf8');
  assert.match(robots, /User-agent: \*\s+Disallow: \//);
  assert.match(robots, /User-agent: Google-Extended\s+Disallow: \//);
  assert.doesNotMatch(robots, /^Allow:|^Sitemap:/mi);
});
