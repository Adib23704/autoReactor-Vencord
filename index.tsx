/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { ChannelStore, Toasts, useState } from "@webpack/common";

const cl = classNameFactory("vc-autoReactor-");
const logger = new Logger("AutoReactor");

const addReaction = findByCodeLazy("MESSAGE_REACTION_ADD", "userHasReactedWithEmoji") as
    (channelId: string, messageId: string, emoji: ReactionEmoji, location?: string) => void;

const MAX_EMOJIS = 10;
const MIN_DELAY_MS = 300;

interface ReactionEmoji {
    id: string | null;
    name: string;
    animated: boolean;
}

interface EmojiSlot {
    id: string;
    value: string;
}

const makeEmptySlot = (): EmojiSlot => ({ id: crypto.randomUUID(), value: "" });
const makeEmptySlotArray = () => [makeEmptySlot()];

const CUSTOM_EMOJI_RE = /^<(a)?:(\w+):(\d+)>$/;

function parseEmoji(input: string): ReactionEmoji | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const custom = trimmed.match(CUSTOM_EMOJI_RE);
    if (custom) {
        const [, animated, name, id] = custom;
        return { id, name, animated: !!animated };
    }

    if (trimmed.startsWith("<") || trimmed.includes(":")) return null;

    return { id: null, name: trimmed, animated: false };
}

const settings = definePluginSettings({
    emojiSlotsConfig: {
        type: OptionType.COMPONENT,
        component: () => {
            const { emojiSlots } = settings.use(["emojiSlots"]);
            return <EmojiSlotsEditor slots={emojiSlots} />;
        }
    },
    emojiSlots: {
        type: OptionType.CUSTOM,
        default: makeEmptySlotArray() as EmojiSlot[],
    },
    delayMs: {
        type: OptionType.NUMBER,
        description: `Delay in milliseconds between each reaction (min ${MIN_DELAY_MS}). Higher is safer against rate limits.`,
        default: 1000,
    },
});

function SlotInput({ initialValue, onChange }: { initialValue: string; onChange(v: string): void; }) {
    const [value, setValue] = useState(initialValue);
    return (
        <input
            type="text"
            className={cl("row-input")}
            placeholder="<:name:id>, <a:name:id> or a unicode emoji 😀"
            value={value}
            spellCheck={false}
            onChange={e => setValue(e.currentTarget.value)}
            onBlur={() => value !== initialValue && onChange(value)}
        />
    );
}

function EmojiSlotsEditor({ slots }: { slots: EmojiSlot[]; }) {
    const [, forceUpdate] = useState(0);
    const rerender = () => forceUpdate(x => x + 1);

    function onChange(value: string, index: number) {
        slots[index].value = value;
        rerender();
    }

    function onRemove(index: number) {
        slots.splice(index, 1);
        if (slots.length === 0) slots.push(makeEmptySlot());
        rerender();
    }

    function onAdd() {
        if (slots.length >= MAX_EMOJIS) return;
        slots.push(makeEmptySlot());
        rerender();
    }

    const lastEmpty = slots.length > 0 && slots[slots.length - 1].value.trim() === "";

    return (
        <>
            <div>
                <HeadingSecondary>Reaction Emojis</HeadingSecondary>
                <Paragraph>
                    Up to {MAX_EMOJIS} emojis added (in order) when you click "Auto React" on a message.
                    Paste custom emoji markdown (<code>{"<:name:id>"}</code> / <code>{"<a:name:id>"}</code>)
                    or a built-in unicode emoji.
                </Paragraph>
            </div>
            <div className={cl("list")}>
                {slots.map((slot, index) => {
                    const state = slot.value.trim() === ""
                        ? "empty"
                        : parseEmoji(slot.value) !== null ? "valid" : "invalid";
                    return (
                        <div key={slot.id} className={cl("row")}>
                            <span
                                className={cl("status", `status-${state}`)}
                                aria-label={state === "invalid" ? "Invalid emoji" : state === "valid" ? "Valid emoji" : "Empty"}
                                title={state === "invalid" ? "Invalid emoji" : state === "valid" ? "Valid emoji" : "Empty slot"}
                            >
                                {state === "valid" ? "✓" : state === "invalid" ? "✕" : index + 1}
                            </span>
                            <SlotInput
                                initialValue={slot.value}
                                onChange={v => onChange(v, index)}
                            />
                            <Button
                                className={cl("delete")}
                                variant="dangerPrimary"
                                size="small"
                                onClick={() => onRemove(index)}
                            >
                                Delete
                            </Button>
                        </div>
                    );
                })}
            </div>
            <Button
                className={cl("add")}
                onClick={onAdd}
                disabled={slots.length >= MAX_EMOJIS || lastEmpty}
            >
                {slots.length >= MAX_EMOJIS ? `Max ${MAX_EMOJIS} reached` : "Add Emoji"}
            </Button>
        </>
    );
}

interface ReactionJob {
    channelId: string;
    messageId: string;
}

const queue: ReactionJob[] = [];
let isDraining = false;

function showToast(type: string, message: string) {
    Toasts.show({ id: Toasts.genId(), type, message });
}

function getConfiguredEmojis(): ReactionEmoji[] {
    return settings.store.emojiSlots
        .map(slot => parseEmoji(slot.value))
        .filter((e): e is ReactionEmoji => e !== null)
        .slice(0, MAX_EMOJIS);
}

function getDelay() {
    return Math.max(MIN_DELAY_MS, settings.store.delayMs || 0);
}

async function runJob(job: ReactionJob) {
    // Read settings per job so edits made while the queue is draining take effect.
    const emojis = getConfiguredEmojis();
    if (emojis.length === 0) {
        showToast(Toasts.Type.FAILURE, "No valid emojis configured. Set them in AutoReactor settings.");
        return;
    }

    const delay = getDelay();

    for (let i = 0; i < emojis.length; i++) {
        try {
            addReaction(job.channelId, job.messageId, emojis[i], "Message");
        } catch (e) {
            logger.error("Failed to add reaction", emojis[i], e);
        }
        if (i < emojis.length - 1) await sleep(delay);
    }

    const remaining = queue.length;
    showToast(
        Toasts.Type.SUCCESS,
        `Added ${emojis.length} reaction${emojis.length === 1 ? "" : "s"}.`
        + (remaining > 0 ? ` ${remaining} message${remaining === 1 ? "" : "s"} left in queue.` : "")
    );
}

async function drainQueue() {
    if (isDraining) return;
    isDraining = true;

    try {
        while (queue.length > 0) {
            const job = queue[0];
            try {
                await runJob(job);
            } catch (e) {
                logger.error("Failed to process queued message", job, e);
            } finally {
                // Stays at index 0 for the whole job so isQueued() sees it as in-flight.
                queue.shift();
            }
            if (queue.length > 0) await sleep(getDelay());
        }
    } finally {
        isDraining = false;
    }
}

function isQueued(channelId: string, messageId: string) {
    return queue.some(job => job.channelId === channelId && job.messageId === messageId);
}

function autoReact(channel: Channel, message: Message) {
    if (isQueued(channel.id, message.id)) {
        showToast(Toasts.Type.MESSAGE, "That message is already queued.");
        return;
    }

    if (getConfiguredEmojis().length === 0) {
        showToast(Toasts.Type.FAILURE, "No valid emojis configured. Set them in AutoReactor settings.");
        return;
    }

    queue.push({ channelId: channel.id, messageId: message.id });

    if (isDraining) {
        showToast(Toasts.Type.MESSAGE, `Queued — position ${queue.length - 1} in line.`);
    }

    drainQueue();
}

function AutoReactIcon({ height = 24, width = 24, className }: { height?: number | string; width?: number | string; className?: string; }) {
    return (
        <svg
            className={className}
            height={height}
            width={width}
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10c.464 0 .921-.032 1.37-.093a6.96 6.96 0 0 1-.879-1.943c-.163.011-.327.036-.491.036-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8c0 .164-.025.328-.036.491a6.96 6.96 0 0 1 1.943.879c.06-.449.093-.906.093-1.37 0-5.523-4.477-10-10-10Z" />
            <path d="M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM15.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12 17.5c-2.03 0-3.79-1.06-4.7-2.62a.75.75 0 0 1 1.3-.76c.65 1.12 1.94 1.88 3.4 1.88.18 0 .35-.01.52-.04a6.98 6.98 0 0 1 .8-2.35c-.42.1-.86.15-1.32.15Z" />
            <path d="M18 13a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm2.5 5.75h-1.75v1.75a.75.75 0 0 1-1.5 0v-1.75H15.5a.75.75 0 0 1 0-1.5h1.75V15.5a.75.75 0 0 1 1.5 0v1.75h1.75a.75.75 0 0 1 0 1.5Z" />
        </svg>
    );
}

export default definePlugin({
    name: "AutoReactor",
    description: "Adds a button to the message actions bar that reacts with up to 10 preset emojis. Reactions are sent sequentially with a configurable delay to stay within Discord's rate limits, and multiple messages queue up instead of being rejected.",
    tags: ["Reactions", "Emotes", "Utility"],
    authors: [{ name: "__azuree__", id: 451657007791996929n }],
    settings,

    messagePopoverButton: {
        icon: AutoReactIcon,
        render(message) {
            if ((message as any).deleted) return null;

            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return null;

            return {
                label: "Auto React",
                icon: AutoReactIcon,
                message,
                channel,
                onClick: () => autoReact(channel, message)
            };
        }
    },

    start() {
        settings.store.emojiSlots.forEach(slot => slot.id ??= crypto.randomUUID());
    },
});
