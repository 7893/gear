// Viewer-request function: runs before the cache, including cache hits.
// robots.txt stays readable so automated clients can discover the policy.
function handler(event) {
    var request = event.request;
    if (request.uri === '/robots.txt') return request;
    var agent = request.headers['user-agent'];
    var blocked = /bot|crawler|spider|slurp|bingpreview|googleother|google-inspectiontool|google-extended|chatgpt-user|claude-user|claude-web|anthropic-ai|perplexity-user|cohere-ai|meta-externalagent|meta-externalfetcher|facebookexternalhit/i;
    if (!agent || !blocked.test(agent.value)) return request;
    return {
        statusCode: 403,
        statusDescription: 'Forbidden',
        headers: {
            'cache-control': {value: 'no-store'},
            'content-type': {value: 'text/plain; charset=utf-8'},
            'x-content-type-options': {value: 'nosniff'},
            'x-robots-tag': {value: 'noindex, nofollow, noarchive, nosnippet, noimageindex'}
        },
        body: 'Automated crawling is not permitted.\n'
    };
}
