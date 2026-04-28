/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { showNotification } from "@api/Notifications";
import { BaseText } from "@components/BaseText";
import { Span } from "@components/Span";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findByCode, findByProps, findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildChannelStore, RestAPI, showToast, Toasts, useEffect, useState } from "@webpack/common";

const FLUX_EVENTS = {
    RUNNING_GAMES: "RUNNING_GAMES_CHANGE"
} as const;

const ApplicationStreamingStore = findStoreLazy("ApplicationStreamingStore");
const questAssetsBaseUrl = "https://cdn.discordapp.com/quests/";
const QUEST_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"] as const;

type QuestTaskName = typeof QUEST_TASKS[number];

const QUEST_ERROR_MESSAGES: Record<QuestTaskName, string> = {
    WATCH_VIDEO: "Failed to update video progress",
    WATCH_VIDEO_ON_MOBILE: "Failed to update video progress",
    PLAY_ON_DESKTOP: "Failed to update game progress",
    STREAM_ON_DESKTOP: "Failed to update stream progress",
    PLAY_ACTIVITY: "Failed to update activity progress"
};

interface RunningQuest {
    interval?: NodeJS.Timeout;
    cleanup?: () => void;
    questId: string;
    applicationName: string;
    questName: string;
    taskName: QuestTaskName;
    gameInstance?: any;
    progressInterval?: NodeJS.Timeout;
    cancelled?: boolean;
}

interface QuestCompletionContext {
    quest: any;
    currentStream: any;
    runningQuest: RunningQuest;
    applicationId: string;
    applicationName: string;
    questName: string;
    secondsNeeded: number;
    taskName: QuestTaskName;
    showQuestNotification(title: string, body: string): void;
}

const runningQuests = new Map<string, RunningQuest>();
const runningQuestListeners = new Set<() => void>();
const isApp = navigator.userAgent.includes("Electron/");

function getQuestById(questId: string) {
    const QuestsStore = findByProps("getQuest");
    return QuestsStore.quests.get(questId);
}

function encodeStreamKey(e): string {
    const { streamType: t, guildId: n, channelId: r, ownerId: s } = e;
    switch (t) {
        case "guild":
            if (!n) throw new Error("guildId is required for streamType GUILD");
            return [t, n, r, s].join(":");
        case "call":
            return [t, r, s].join(":");
        default:
            throw new Error("Unknown stream type ".concat(t));
    }
}

function getRunningQuestsSnapshot() {
    return Array.from(runningQuests.values());
}

function emitRunningQuestsChange() {
    for (const listener of runningQuestListeners) listener();
}

function useRunningQuests() {
    const [quests, setQuests] = useState<RunningQuest[]>(getRunningQuestsSnapshot);

    useEffect(() => {
        const listener = () => setQuests(getRunningQuestsSnapshot());
        runningQuestListeners.add(listener);

        return () => void runningQuestListeners.delete(listener);
    }, []);

    return quests;
}

function isQuestRunning(questId: string) {
    return runningQuests.has(questId) && !runningQuests.get(questId)?.cancelled;
}

function endQuest(questId: string) {
    const questData = runningQuests.get(questId);
    if (!questData) return null;

    console.log("[Quest] Ending quest:", questData.questName);
    questData.cancelled = true;

    if (questData.interval) {
        clearInterval(questData.interval);
        console.log("[Quest] Cleared main interval");
    }
    if (questData.progressInterval) {
        clearInterval(questData.progressInterval);
        console.log("[Quest] Cleared progress interval");
    }

    if (questData.cleanup) {
        console.log("[Quest] Executing cleanup");
        try {
            questData.cleanup();
        } catch (error) {
            console.error("[Quest] Cleanup failed:", error);
        }
    }

    runningQuests.delete(questId);
    emitRunningQuestsChange();
    console.log("[Quest] Removed from tracking");

    return questData;
}

function stopQuest(questId: string) {
    const questData = endQuest(questId);
    if (!questData) return;

    showToast(`Stopped quest: ${questData.questName}`, Toasts.Type.MESSAGE);
}

function getQuestImageConfig(questId: string) {
    const quest = getQuestById(questId);
    return {
        icon: `${questAssetsBaseUrl}${questId}/dark/${quest.config.assets.logotype}`,
        image: `${questAssetsBaseUrl}${questId}/${quest.config.assets.hero}`
    };
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getQuestProgress(quest: any, taskName: QuestTaskName) {
    return quest.userStatus?.progress?.[taskName]?.value ?? 0;
}

function getQuestErrorMessage(context: QuestCompletionContext, error: unknown) {
    if (error instanceof Error && error.message) return error.message;

    return QUEST_ERROR_MESSAGES[context.taskName];
}

function completeQuest(context: QuestCompletionContext) {
    if (!endQuest(context.quest.id)) return;

    context.showQuestNotification("Completed", "Quest finished!");
    console.log(`[Quest] ${context.questName} completed.`);
}

function failQuest(context: QuestCompletionContext, error: unknown) {
    if (!endQuest(context.quest.id)) return;

    console.error(`[Quest] ${context.taskName} failed:`, error);
    showToast(getQuestErrorMessage(context, error), Toasts.Type.FAILURE);
}

async function runQuestStep(context: QuestCompletionContext, step: () => Promise<void> | void) {
    if (!isQuestRunning(context.quest.id)) return;

    try {
        await step();
    } catch (error) {
        failQuest(context, error);
    }
}

function setQuestInterval(context: QuestCompletionContext, step: () => Promise<void> | void, delay: number) {
    context.runningQuest.progressInterval = setInterval(() => {
        void runQuestStep(context, step);
    }, delay);
}

async function completeVideoQuest(context: QuestCompletionContext) {
    const STEP_SIZE = 7; // seconds advanced each tick
    const GRACE_WINDOW = 10; // how far ahead the fake progress can be
    const UPDATE_DELAY = 1; // seconds between each update

    const { quest, questName, secondsNeeded, taskName } = context;
    const startedAt = new Date(quest.userStatus?.enrolledAt ?? Date.now() - 15 * 1000).getTime();
    let progress = getQuestProgress(quest, taskName);
    let done = false;

    console.log(`[Quest] Starting ${taskName}: ${questName} at ${progress}/${secondsNeeded}s`);

    while (progress < secondsNeeded && !done && isQuestRunning(quest.id)) {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        const maxReachable = elapsed + GRACE_WINDOW;

        if (maxReachable >= progress + STEP_SIZE) {
            const next = Math.min(secondsNeeded, progress + STEP_SIZE + Math.random());
            const res = await RestAPI.post({
                url: `/quests/${quest.id}/video-progress`,
                body: { timestamp: next }
            });

            if (!isQuestRunning(quest.id)) return;

            progress = next;
            done = !!res.body?.completed_at;

            if (done) {
                console.log("[Quest] Server confirmed completion.");
                break;
            }
        }

        if (progress >= secondsNeeded) break;
        await sleep(UPDATE_DELAY * 1000);
    }

    if (!isQuestRunning(quest.id)) return;

    if (!done) {
        await RestAPI.post({
            url: `/quests/${quest.id}/video-progress`,
            body: { timestamp: secondsNeeded }
        });
        console.log("[Quest] Sent final completion timestamp.");
    }

    completeQuest(context);
}

async function completeDesktopQuest(context: QuestCompletionContext) {
    const { quest, applicationId, applicationName, secondsNeeded, taskName, runningQuest } = context;
    const RunningGameStore = findStoreLazy("RunningGameStore");
    const res = await RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` });

    if (!isQuestRunning(quest.id)) return;

    const appData = res.body[0];
    if (!appData) throw new Error("Failed to load application data");

    let exeName = applicationName.toLowerCase().replace(/\s+/g, "") + ".exe";
    if (appData.executables && Array.isArray(appData.executables)) {
        const executable = appData.executables.find(x => x.os === "win32");
        if (executable?.name) exeName = executable.name.replace(">", "");
    }

    const pid = Math.floor(Math.random() * 30000) + 1000;
    const parentPid1 = Math.floor(Math.random() * 30000) + 1000;
    const parentPid2 = Math.floor(Math.random() * 30000) + 1000;
    const parentPid3 = Math.floor(Math.random() * 30000) + 1000;

    const fakeGame = {
        cmdLine: "",
        distributor: appData.distributor ?? "steam",
        elevated: false,
        exeName: exeName.toLowerCase(),
        exePath: `c:/program files (x86)/steam/steamapps/common/${appData.name.toLowerCase()}/${exeName.toLowerCase()}`,
        executableFingerprint: undefined,
        fullscreenType: 1,
        gameMetadata: undefined,
        hidden: false,
        id: applicationId,
        isLauncher: false,
        lastFocused: 0,
        name: appData.name,
        nativeProcessObserverId: Math.floor(Math.random() * 30000) + 1000,
        origGameName: appData.name,
        pid,
        pidPath: [parentPid1, parentPid2, parentPid3, pid],
        processName: appData.name,
        sandboxed: false,
        sku: appData.primary_sku_id ?? undefined,
        start: Date.now(),
        windowHandle: String(Math.floor(Math.random() * 9000000) + 1000000),
    };

    runningQuest.gameInstance = fakeGame;
    runningQuest.cleanup = () => {
        clearInterval(runningQuest.progressInterval!);
        FluxDispatcher.dispatch({
            type: FLUX_EVENTS.RUNNING_GAMES,
            added: [],
            removed: [fakeGame],
            games: RunningGameStore.getRunningGames().filter(g => g.pid !== fakeGame.pid)
        });
    };

    FluxDispatcher.dispatch({
        type: FLUX_EVENTS.RUNNING_GAMES,
        added: [fakeGame],
        removed: [],
        games: [...RunningGameStore.getRunningGames(), fakeGame]
    });

    const getCurrentProgress = () => {
        const currentQuest = getQuestById(quest.id);
        if (!currentQuest) return 0;

        return quest.config.configVersion === 1
            ? currentQuest.userStatus?.streamProgressSeconds || 0
            : currentQuest.userStatus?.progress?.[taskName]?.value || 0;
    };

    const sendHeartbeat = async () => {
        await RestAPI.post({
            url: `/quests/${quest.id}/heartbeat`,
            body: {
                stream_key: null,
                terminal: false,
                metadata: {
                    game: {
                        name: appData.name,
                        pid,
                        start: fakeGame.start
                    }
                }
            }
        });
    };

    const updateProgress = async () => {
        await sendHeartbeat();
        if (!isQuestRunning(quest.id)) return;

        const progress = getCurrentProgress();
        if (progress < secondsNeeded) return;
        if (!isQuestRunning(quest.id)) return;

        await sendHeartbeat();
        if (!isQuestRunning(quest.id)) return;

        completeQuest(context);
    };

    await updateProgress();
    if (!isQuestRunning(quest.id)) return;

    setQuestInterval(context, updateProgress, 30000);
}

function completeStreamQuest(context: QuestCompletionContext) {
    const { quest, applicationId, currentStream, secondsNeeded, runningQuest } = context;
    const pid = Math.floor(Math.random() * 30000) + 1000;
    const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;

    ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
        id: applicationId,
        pid,
        sourceName: null
    });

    runningQuest.cleanup = () => {
        clearInterval(runningQuest.progressInterval!);
        ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
    };

    const progressAtStart = getQuestProgress(quest, context.taskName);
    const startTime = Date.now();

    const updateProgress = async () => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const progress = Math.min(progressAtStart + elapsed, secondsNeeded);

        await RestAPI.post({
            url: `/quests/${quest.id}/heartbeat`,
            body: { stream_key: encodeStreamKey(currentStream), terminal: false }
        });

        if (!isQuestRunning(quest.id)) return;

        if (progress >= secondsNeeded) completeQuest(context);
    };

    setQuestInterval(context, updateProgress, 30000);
    void runQuestStep(context, updateProgress);
}

function completeActivityQuest(context: QuestCompletionContext) {
    const { quest, secondsNeeded, runningQuest } = context;
    const questsHeartbeat = findByCode("QUESTS_HEARTBEAT");
    const channelId = ChannelStore.getSortedPrivateChannels()[0]?.id ??
        (Object.values(GuildChannelStore.getAllGuilds()) as any[])
            .find(x => x?.VOCAL?.length > 0)?.VOCAL?.[0].channel?.id ?? null;

    if (!channelId) throw new Error("No available voice channel or DM found for this quest");

    const streamKey = `call:${channelId}:1`;
    const progressAtStart = getQuestProgress(quest, context.taskName);
    const startTime = Date.now();

    const updateProgress = async () => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const progress = Math.min(progressAtStart + elapsed, secondsNeeded);

        await questsHeartbeat({ questId: quest.id, streamKey, terminal: false });

        if (!isQuestRunning(quest.id)) return;
        if (progress < secondsNeeded) return;

        await questsHeartbeat({ questId: quest.id, stream_key: streamKey, terminal: true });
        if (!isQuestRunning(quest.id)) return;

        completeQuest(context);
    };

    runningQuest.cleanup = () => {
        clearInterval(runningQuest.progressInterval!);
    };

    setQuestInterval(context, updateProgress, 20000);
    void runQuestStep(context, updateProgress);
}

const questCompleters: Record<QuestTaskName, (context: QuestCompletionContext) => Promise<void> | void> = {
    WATCH_VIDEO: completeVideoQuest,
    WATCH_VIDEO_ON_MOBILE: completeVideoQuest,
    PLAY_ON_DESKTOP: completeDesktopQuest,
    STREAM_ON_DESKTOP: completeStreamQuest,
    PLAY_ACTIVITY: completeActivityQuest
};

function QuestCompleterSettings() {
    const quests = useRunningQuests();

    return (
        <>
            {isApp ? (
                <BaseText size="lg" weight="bold">
                    The plugin should work properly because you are on the Desktop Client.
                </BaseText>
            ) : (
                <BaseText size="lg" weight="bold" style={{ color: "var(--text-danger)" }}>
                    Error: This plugin only works for non-video quests in the browser.
                </BaseText>
            )}
            <div style={{ marginTop: "10px" }}>
                <BaseText size="md" weight="bold">Currently running quests:</BaseText>
                {quests.map(quest => (
                    <div key={quest.questId} style={{ display: "flex", alignItems: "center", marginTop: "5px" }}>
                        <Span size="md">{quest.questName} ({quest.taskName})</Span>
                        <button
                            onClick={() => stopQuest(quest.questId)}
                            style={{ marginLeft: "10px", padding: "2px 5px" }}
                        >
                            Stop
                        </button>
                    </div>
                ))}
            </div>
        </>
    );
}

export default definePlugin({
    name: "QuestCompleter",
    description: "Auto complete quests without any requirements.",
    authors: [Devs.Loukious],
    patches: [
        {
            find: 'id:"share-link"',
            replacement: {
                match: /questId:(\w+)\.quest\.id(.*?)(\(0,(\w{1,3})\.(\w{1,3})\)\((\w{1,3})\.(\w{1,3}),\{id:"share-link"[^}]+}\}[^)]*\))/,
                replace: 'questId:$1.quest.id$2$3,(0,$4.$5)($6.$7,{id:"Auto-complete",label:"Auto Complete",action:()=>{$self.openCompleteQuest($1.quest.id);}})'
            }
        }
    ],

    settingsAboutComponent: QuestCompleterSettings,

    start() { },

    stop() {
        for (const questId of Array.from(runningQuests.keys())) endQuest(questId);
    },

    async openCompleteQuest(questId: string) {
        let quest = getQuestById(questId);
        if (!quest) {
            showToast("Quest not found!");
            return;
        }

        // Changed to stop if already running
        if (runningQuests.has(quest.id)) {
            stopQuest(quest.id);
            return;
        }

        const taskName = QUEST_TASKS.find(x => quest.config.taskConfigV2.tasks[x] != null);

        if (quest.userStatus?.completedAt) {
            showToast("This quest is already completed!");
            return;
        }

        if (new Date(quest.config.expiresAt).getTime() < Date.now()) {
            showToast("This quest has expired!");
            return;
        }

        if (!taskName) {
            showToast("Unsupported quest type!");
            return;
        }

        if (!quest.userStatus?.enrolledAt) {
            showToast("Attempting to enroll in quest...");
            const res = await RestAPI.post({
                url: `/quests/${quest.id}/enroll`,
                body: {
                    location: 11,
                    is_targeted: false
                }
            });
            if (res.status !== 200) {
                if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
                    showToast("You need to start playing the video first, then pause it or accept the quest!");
                } else {
                    showToast("Failed to auto enroll in the quest. Please try manually.");
                }
                return;
            } else {
                showToast("Successfully auto enrolled in the quest!");
                await sleep(2000);
                quest = getQuestById(questId);
                if (!quest) {
                    showToast("Quest not found!");
                    return;
                }
            }
        }

        const currentStream = ApplicationStreamingStore.getCurrentUserActiveStream();

        try {
            if (taskName === "STREAM_ON_DESKTOP" && !isApp) {
                showToast("Desktop app required for streaming quests!", Toasts.Type.FAILURE);
                return;
            }

            if (taskName === "STREAM_ON_DESKTOP") {
                if (!currentStream) {
                    showToast("You need to be streaming to complete this quest!");
                    return;
                }

                const viewerIds = ApplicationStreamingStore.getViewerIds(encodeStreamKey(currentStream));
                if (!viewerIds?.length) {
                    showToast("You need at least one viewer in your stream!");
                    return;
                }
            }

            if (taskName === "PLAY_ON_DESKTOP" && !isApp) {
                showToast("Desktop app required for gameplay quests!");
                return;
            }
        } catch (error) {
            showToast(error instanceof Error ? error.message : "An unknown error occurred");
            return;
        }

        const applicationId = quest.config.application.id;
        const applicationName = quest.config.application.name;
        const { questName } = quest.config.messages;
        const secondsNeeded = quest.config.taskConfigV2.tasks[taskName].target;

        const runningQuest: RunningQuest = {
            questId: quest.id,
            applicationName,
            questName,
            taskName
        };
        runningQuests.set(quest.id, runningQuest);
        emitRunningQuestsChange();

        const showQuestNotification = (title: string, body: string) => {
            showNotification({
                title: `${questName} - ${title}`,
                body: `${body}`,
                ...getQuestImageConfig(quest.id)
            });
        };

        const context: QuestCompletionContext = {
            quest,
            currentStream,
            runningQuest,
            applicationId,
            applicationName,
            questName,
            secondsNeeded,
            taskName,
            showQuestNotification
        };

        showToast(`Starting quest: ${questName}`, Toasts.Type.SUCCESS);
        void runQuestStep(context, () => questCompleters[taskName](context));
    }
});
