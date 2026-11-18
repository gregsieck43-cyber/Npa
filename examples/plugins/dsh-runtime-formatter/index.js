import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-runtime-formatter';
export const inject = ['tools'];
export const Config = Schema.object({
  uppercase: Schema.boolean().default(false),
  prefix: Schema.string().default(''),
});

export function apply(ctx, config) {
  const disposed = [];
  ctx.tools.register(defineTool({
    name: 'dsh_clean',
    description: 'Normalize newlines and trim text, optionally uppercase and prefix it.',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }]; },
    },
    execute(args) {
      const clean = args.text.replace(/\r\n?/g, '\n').trim();
      return config.prefix + (config.uppercase ? clean.toUpperCase() : clean);
    },
  }));
  ctx.effect(() => () => {
    if (disposed.join(',') !== 'apply,b') throw new Error('Effect A was disposed out of order or more than once.');
    disposed.push('a');
  }, 'effect-a');
  ctx.effect(() => () => {
    if (disposed.join(',') !== 'apply') throw new Error('Effect B was disposed out of order or more than once.');
    disposed.push('b');
  }, 'effect-b');
  return () => {
    if (disposed.length) throw new Error('Apply was disposed out of order or more than once.');
    disposed.push('apply');
  };
}
