/** bash/powershell 未传 timeout（内置无超时）时补默认值，显式传入不覆盖 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_SECONDS = 120;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;

		const input = event.input as { timeout?: number };
		if (input.timeout === undefined) {
			input.timeout = DEFAULT_TIMEOUT_SECONDS;
		}
		return undefined;
	});
}
