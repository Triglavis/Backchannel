import { expireAccountState, fetchAccount } from "./account/worker.mjs";
import { flushTopicReportDeletions } from "./account/topic-reports.mjs";

const HOME = "backchnnl.app";

function isPreview(hostname) {
	return hostname.split(".")[0].endsWith("-backchannel");
}

export default {
	scheduled(_event, env, ctx) {
		ctx.waitUntil(expireAccountState(env.ACCOUNTS_DB));
		ctx.waitUntil(flushTopicReportDeletions(env));
	},
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const accountPath = url.pathname === "/account" || url.pathname.startsWith("/account/");
		if (accountPath && (url.hostname === HOME || url.hostname === "localhost")) {
			return fetchAccount(request, env, url, url.hostname === HOME ? `https://${HOME}` : url.origin, ctx);
		}

		if (url.hostname !== HOME && !isPreview(url.hostname)) {
			return Response.redirect(`https://${HOME}${url.pathname}${url.search}`, 301);
		}

		if (url.pathname === "/sidebar-settings" && (request.method === "GET" || request.method === "HEAD")) {
			const body = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Backchannel&nbsp;Settings</title><body></body></html>';
			return new Response(request.method === "HEAD" ? null : body, {
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
					"Referrer-Policy": "no-referrer",
					"X-Content-Type-Options": "nosniff",
				},
			});
		}

		const response = await env.ASSETS.fetch(request);

		return response.status === 404 ? Response.redirect(new URL("/", url).href, 302) : response;
	},
};
