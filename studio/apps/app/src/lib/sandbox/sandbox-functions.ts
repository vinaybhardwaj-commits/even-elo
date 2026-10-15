import { z } from "zod";
import type { SandboxFunction } from "@copilotkit/react-core/v2";

export const SEND_PROMPT_EVENT = "opengenui:send-prompt";

// Host-applied tag so the agent can tell widget-origin prompts from text the
// user typed. The widget cannot omit it: the host adds it after validation.
export const WIDGET_PROMPT_PREFIX = "[widget-origin] ";

const formatIssues = (error: z.ZodError) =>
  error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

export const sendPromptParameters = z.object({
  text: z.string().trim().min(1).max(4000),
});

// This request stays inside the host window; only the settled result crosses
// the Websandbox bridge. A listener must claim it synchronously during dispatch.
export interface SendPromptRequest {
  text: string;
  claim: () => boolean;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export const sendPromptFunction: SandboxFunction = {
  name: "sendPrompt",
  description:
    "Sends a follow-up message to the chat, tagged as widget-originated. Call as: await Websandbox.connection.remote.sendPrompt({ text }).",
  parameters: sendPromptParameters,
  handler: async (args) => {
    const result = sendPromptParameters.safeParse(args);
    if (!result.success) {
      throw new Error(
        `sendPrompt: invalid arguments — ${formatIssues(result.error)}`,
      );
    }
    return new Promise<{ ok: true }>((resolve, reject) => {
      let claimed = false;
      const request: SendPromptRequest = {
        text: result.data.text,
        claim: () => {
          if (claimed) return false;
          claimed = true;
          return true;
        },
        resolve: () => resolve({ ok: true }),
        reject,
      };
      window.dispatchEvent(
        new CustomEvent(SEND_PROMPT_EVENT, { detail: request }),
      );
      if (!claimed) {
        reject(
          new Error(
            "sendPrompt: chat bridge unavailable. Please reload the page and try again.",
          ),
        );
      }
    });
  },
};

export const SANDBOX_FUNCTIONS: readonly SandboxFunction[] = [
  sendPromptFunction,
];
