import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { evaluate, inputShape } from './evaluate.mjs';

const server = new McpServer({ name: 'typesafe-jev', version: '1.0.0' });
server.registerTool('evaluate', {
  title: 'TypeSafe Jev structured evaluation',
  description: 'Call the paid TypeSafe Jev API for narrow judgments on supplied evidence. '
    + 'Use choice for classification (criteria: option-to-description object), score for rubric ratings '
    + '(criteria: 2–10 ordered descriptions; score ranges from 0 to levels minus 1), '
    + 'or noul for yes/no probability. Batch independent questions sharing the same state. '
    + 'Returns original answers, probabilities, confidence (choice/score only), and token usage. '
    + 'Not a search engine or a source of verified facts. Do not use for open-ended writing or long reasoning.',
  inputSchema: inputShape,
}, async (input, extra) => {
  try {
    const result = await evaluate(input, { signal: extra.signal });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    let message = error instanceof Error ? error.message : 'TypeSafe request failed';
    const key = process.env.TYPESAFE_API_KEY?.trim();
    if (key) message = message.replaceAll(key, '[REDACTED]');
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
});

await server.connect(new StdioServerTransport());
