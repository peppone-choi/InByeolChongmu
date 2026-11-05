import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import { z } from 'zod';
import { toolCatalog, type Tools } from '../tools/registry.js';

// Definitions bind the real read-only tools without starting a provider or model loop.
export function createFlueTools(tools: Tools) {
  return toolCatalog().map(({ name, description }) =>
    defineTool({
      name,
      description,
      input: v.strictObject({ arguments: v.record(v.string(), v.unknown()) }),
      run: ({ data }) => ({
        output: z.json().parse(tools.call(name, data.arguments)),
      }),
    }),
  );
}
