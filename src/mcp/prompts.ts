import { z } from 'zod';

export const SecureEvalPromptArgsSchema = z.object({
  code: z.string().describe('Source code snippet to evaluate'),
  language: z.string().default('javascript').describe('Programming language'),
});

export const DataProcessingPromptArgsSchema = z.object({
  task: z.string().describe('Description of the data processing task'),
  script: z.string().describe('Batch script to run'),
});

export function getSecureEvalPrompt(args: z.infer<typeof SecureEvalPromptArgsSchema>) {
  return {
    description: 'Execute code in secure sandbox',
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Execute the following ${args.language} code safely in the sandbox runner and inspect output:\n\n\`\`\`${args.language}\n${args.code}\n\`\`\``,
        },
      },
    ],
  };
}

export function getDataProcessingPrompt(args: z.infer<typeof DataProcessingPromptArgsSchema>) {
  return {
    description: 'Batch data processing in sandbox',
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Run the following data processing task in the sandbox with input staging and artifact collection:\nTask: ${args.task}\n\nScript:\n${args.script}`,
        },
      },
    ],
  };
}
