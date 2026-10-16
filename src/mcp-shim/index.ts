export function runMcpShim(io: { stderr: { write(chunk: string): unknown } }): number {
  io.stderr.write('gsd-atlas-mcp: the MCP server arrives in Phase 2; nothing is served yet.\n');
  return 1;
}
