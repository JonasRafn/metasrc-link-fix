import { NextRequest } from "next/server";

const RIOT_API_REGIONS = {
	europe: "https://europe.api.riotgames.com",
	americas: "https://americas.api.riotgames.com",
	asia: "https://asia.api.riotgames.com",
	sea: "https://sea.api.riotgames.com",
} as const;

function getHeaders() {
	const token = process.env.RIOT_API_TOKEN;
	if (!token) {
		throw new Error("RIOT_API_TOKEN environment variable is not set");
	}
	return { "X-Riot-Token": token };
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1200; // Riot limit: 100 requests per 2 minutes = 1 per 1.2s
const MAX_DELAY_MS = 5000;

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAccount(gameName: string, tagLine: string) {
	const region = "europe";
	const RIOT_API_BASE = RIOT_API_REGIONS[region];
	const url = `${RIOT_API_BASE}/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`;

	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		const response = await fetch(url, { headers: getHeaders() });

		if (response.status === 429) {
			const retryAfter = parseInt(response.headers.get("Retry-After") || "2", 10);
			await sleep(retryAfter * 1000 * (attempt + 1));
			continue;
		}

		const data = await response.json();
		if (response.ok) {
			return { success: true, data };
		}
		return { success: false, error: data.error || "Account not found" };
	}
	return { success: false, error: "Rate limited — please wait a moment and try again" };
}

const ARENA_QUEUES = ["1700", "1750"]; // 2v2 + 3v3

async function getMatchIds(puuid: string, queue: string, start: number, count: number, knownRegion?: string) {
	const regions = knownRegion ? [knownRegion] : ["americas", "europe", "asia", "sea"];
	let lastError: { status?: number; message?: string } | null = null;

	for (const region of regions) {
		try {
			const RIOT_API_BASE = RIOT_API_REGIONS[region as keyof typeof RIOT_API_REGIONS];
			const url = `${RIOT_API_BASE}/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${queue}&start=${start}&count=${count}`;

			const response = await fetch(url, { headers: getHeaders() });

			if (response.ok) {
				const data = await response.json();
				if (Array.isArray(data)) {
					if (data.length > 0) {
						return { success: true, data, region };
					}
					// Empty response from this region; if we know the region, return empty (no more matches)
					if (knownRegion) {
						return { success: true, data: [], region };
					}
					continue;
				}
			}

			try {
				const errorData = await response.json();
				lastError = {
					status: response.status,
					message: typeof errorData === "object" && errorData !== null && "error" in errorData
						? String(errorData.error)
						: `HTTP ${response.status}`,
				};
			} catch {
				lastError = {
					status: response.status,
					message: `HTTP ${response.status}`,
				};
			}
		} catch (error) {
			lastError = {
				message: error instanceof Error ? error.message : "Network error",
			};
		}
	}

	if (!lastError) {
		return { success: true, data: [], region: null };
	}

	const errorMessage = lastError.status
		? `Failed to fetch matches (${lastError.status}${lastError.message ? `: ${lastError.message}` : ""})`
		: lastError.message || "Failed to fetch matches from all regions";
	return { success: false, error: errorMessage };
}

function matchIdSortKey(id: string): number {
	const parts = id.split("_");
	return parseInt(parts[parts.length - 1], 10) || 0;
}

interface MatchData {
	info: {
		gameStartTimestamp?: number;
		participants: Array<{
			puuid: string;
			championName: string;
			placement: number;
			riotIdGameName?: string;
			riotIdTagline?: string;
		}>;
	};
}

type MatchInfoResult =
	| { success: true; data: MatchData; region: string; wasRateLimited: boolean }
	| { success: false; error: string; wasRateLimited: boolean };

async function fetchMatchFromRegion(matchId: string, region: string): Promise<{ ok: boolean; status: number; data?: MatchData; retryAfter?: number }> {
	const RIOT_API_BASE = RIOT_API_REGIONS[region as keyof typeof RIOT_API_REGIONS];
	const url = `${RIOT_API_BASE}/lol/match/v5/matches/${matchId}`;

	const response = await fetch(url, { headers: getHeaders() });

	if (response.ok) {
		const data = await response.json();
		return { ok: true, status: 200, data };
	}

	if (response.status === 429) {
		const retryAfter = parseInt(response.headers.get("Retry-After") || "1", 10);
		return { ok: false, status: 429, retryAfter };
	}

	return { ok: false, status: response.status };
}

async function getMatchInfo(matchId: string, region?: string): Promise<MatchInfoResult> {
	let wasRateLimited = false;

	if (region) {
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			const result = await fetchMatchFromRegion(matchId, region);
			if (result.ok && result.data) {
				return { success: true, data: result.data, region, wasRateLimited };
			}
			if (result.status === 429) {
				wasRateLimited = true;
				const waitTime = (result.retryAfter || 1) * 1000 * (attempt + 1);
				await sleep(waitTime);
				continue;
			}
			return { success: false, error: `Failed to fetch match info: ${result.status}`, wasRateLimited };
		}
		return { success: false, error: "Max retries exceeded (rate limited)", wasRateLimited: true };
	}

	// Try all regions for first match
	const regions = ["americas", "europe", "asia", "sea"];
	for (const testRegion of regions) {
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			const result = await fetchMatchFromRegion(matchId, testRegion);
			if (result.ok && result.data) {
				return { success: true, data: result.data, region: testRegion, wasRateLimited };
			}
			if (result.status === 429) {
				wasRateLimited = true;
				const waitTime = (result.retryAfter || 1) * 1000 * (attempt + 1);
				await sleep(waitTime);
				continue;
			}
			if (result.status === 404) {
				break; // Try next region
			}
			break; // Other error, try next region
		}
	}

	return { success: false, error: "Match not found in any region", wasRateLimited };
}

export async function GET(request: NextRequest) {
	const searchParams = request.nextUrl.searchParams;
	const gameName = searchParams.get("gameName");
	const tagLine = searchParams.get("tagLine");
	const start = parseInt(searchParams.get("start") || "0", 10);
	const count = parseInt(searchParams.get("count") || "100", 10);
	const cachedMatchIdsParam = searchParams.get("cachedMatchIds") || "";

	if (!gameName || !tagLine) {
		return new Response(
			JSON.stringify({ error: "Game name and tag line are required" }),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			}
		);
	}

	const cachedMatchIds = cachedMatchIdsParam ? cachedMatchIdsParam.split(",").filter(Boolean) : [];
	const cachedSet = new Set(cachedMatchIds);

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			const sendEvent = (type: string, data: Record<string, unknown>) => {
				const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
				controller.enqueue(encoder.encode(message));
			};

			try {
				// Step 1: Get account
				sendEvent("status", { message: "Looking up account..." });
				const accountResult = await getAccount(gameName, tagLine);

				if (!accountResult.success) {
					sendEvent("error", { error: accountResult.error });
					controller.close();
					return;
				}

				sendEvent("account", { data: accountResult.data });

				// Step 2: Fetch ALL match IDs across all Arena queues (1700 + 1750)
				sendEvent("status", { message: "Fetching match IDs..." });

				const allMatchIds: string[] = [];
				const seen = new Set<string>();
				let detectedListRegion: string | undefined = undefined;

				for (const queue of ARENA_QUEUES) {
					let currentStart = start;
					let hasMore = true;

					while (hasMore) {
						const matchIdsResult = await getMatchIds(
							accountResult.data.puuid,
							queue,
							currentStart,
							count,
							detectedListRegion,
						);

						if (!matchIdsResult.success || !matchIdsResult.data) {
							// Don't error out if one queue fails after we have data from another
							if (allMatchIds.length === 0 && queue === ARENA_QUEUES[0]) {
								sendEvent("error", { error: matchIdsResult.error || "Failed to fetch matches" });
								controller.close();
								return;
							}
							break;
						}

						if (matchIdsResult.region && !detectedListRegion) {
							detectedListRegion = matchIdsResult.region;
						}

						const batchMatchIds = matchIdsResult.data.filter((id: string) => !seen.has(id));
						for (const id of batchMatchIds) seen.add(id);
						allMatchIds.push(...batchMatchIds);

						if (matchIdsResult.data.length < count) {
							hasMore = false;
						} else {
							currentStart += count;
						}
					}
				}

				// Sort all match IDs by descending numeric suffix (newest first)
				allMatchIds.sort((a, b) => matchIdSortKey(b) - matchIdSortKey(a));

				if (allMatchIds.length > 0) {
					sendEvent("matchIdBatch", {
						matchIds: allMatchIds,
						batchNumber: 1,
						hasMore: false,
					});
				}

				sendEvent("matchIds", { count: allMatchIds.length, hasMore: false });

				if (allMatchIds.length === 0) {
					sendEvent("complete", {});
					controller.close();
					return;
				}

				// Step 3: Filter to only fetch details for uncached matches
				const matchIdsNeedingDetails = allMatchIds.filter(id => !cachedSet.has(id));
				const alreadyCached = allMatchIds.length - matchIdsNeedingDetails.length;

				if (alreadyCached > 0) {
					sendEvent("status", { message: `${alreadyCached} matches cached, fetching ${matchIdsNeedingDetails.length} remaining...` });
				}

				if (matchIdsNeedingDetails.length === 0) {
					sendEvent("status", { message: "All matches already cached!" });
					sendEvent("complete", {});
					controller.close();
					return;
				}

				// Step 4: Stream match details with adaptive rate limiting
				let detailsFetched = 0;
				let detectedRegion: string | undefined = undefined;
				let currentDelay = BASE_DELAY_MS;
				const fetchStartTime = Date.now();

				for (let i = 0; i < matchIdsNeedingDetails.length; i++) {
					const matchId = matchIdsNeedingDetails[i];

					// Calculate ETA based on average time per match so far
					const elapsed = Date.now() - fetchStartTime;
					const avgTimePerMatch = i > 0 ? elapsed / i : currentDelay;
					const remaining = matchIdsNeedingDetails.length - i;
					const etaMs = Math.round(avgTimePerMatch * remaining);

					sendEvent("progress", {
						totalIds: allMatchIds.length,
						detailsFetched,
						pending: remaining,
						etaMs,
					});

					const matchResult = await getMatchInfo(matchId, detectedRegion);

					if (matchResult.success) {
						if (!detectedRegion && matchResult.region) {
							detectedRegion = matchResult.region;
						}

						const player = matchResult.data.info.participants.find(
							(p: { puuid: string }) => p.puuid === accountResult.data.puuid
						);

						if (player) {
							const minimalMatchInfo: MatchData = {
								info: {
									gameStartTimestamp: matchResult.data.info.gameStartTimestamp,
									participants: matchResult.data.info.participants.map((p: { puuid: string; championName: string; placement: number; riotIdGameName?: string; riotIdTagline?: string }) => ({
										puuid: p.puuid,
										championName: p.championName,
										placement: p.placement,
										riotIdGameName: p.riotIdGameName,
										riotIdTagline: p.riotIdTagline,
									})),
								},
							};
							sendEvent("match", {
								matchId,
								champion: player.championName,
								placement: player.placement,
								matchInfo: minimalMatchInfo,
							});
							detailsFetched++;
						}
					}

					// Adaptive delay: back off on rate limits, recover when clear
					if (matchResult.wasRateLimited) {
						currentDelay = Math.min(currentDelay * 2, MAX_DELAY_MS);
					} else {
						currentDelay = Math.max(currentDelay * 0.9, BASE_DELAY_MS);
					}

					if (i < matchIdsNeedingDetails.length - 1) {
						await sleep(currentDelay);
					}
				}

				sendEvent("progress", {
					totalIds: allMatchIds.length,
					detailsFetched,
					pending: 0,
					etaMs: 0,
				});

				sendEvent("complete", {});
				controller.close();
			} catch (error) {
				console.error("Error in matches stream:", error);
				sendEvent("error", { error: "Internal server error" });
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
		},
	});
}
