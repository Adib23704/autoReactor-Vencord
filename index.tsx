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
import { Menu, Toasts, useState } from "@webpack/common";

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

let isReacting = false;

async function autoReact(channel: Channel, message: Message) {
    if (isReacting) {
        Toasts.show({
            id: Toasts.genId(),
            type: Toasts.Type.MESSAGE,
            message: "AutoReactor is still busy with the previous message."
        });
        return;
    }

    const emojis = settings.store.emojiSlots
        .map(slot => parseEmoji(slot.value))
        .filter((e): e is ReactionEmoji => e !== null)
        .slice(0, MAX_EMOJIS);

    if (emojis.length === 0) {
        Toasts.show({
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE,
            message: "No valid emojis configured. Set them in AutoReactor settings."
        });
        return;
    }

    const delay = Math.max(MIN_DELAY_MS, settings.store.delayMs || 0);

    isReacting = true;
    try {
        for (let i = 0; i < emojis.length; i++) {
            try {
                addReaction(channel.id, message.id, emojis[i], "Message");
            } catch (e) {
                logger.error("Failed to add reaction", emojis[i], e);
            }
            if (i < emojis.length - 1) await sleep(delay);
        }

        Toasts.show({
            id: Toasts.genId(),
            type: Toasts.Type.SUCCESS,
            message: `Added ${emojis.length} reaction${emojis.length === 1 ? "" : "s"}.`
        });
    } finally {
        isReacting = false;
    }
}

export default definePlugin({
    name: "AutoReactor",
    description: "Right-click a message and react with up to 10 preset emojis. Reactions are sent sequentially with a configurable delay to stay within Discord's rate limits.",
    tags: ["Reactions", "Emotes", "Utility"],
    authors: [{ name: "__azuree__", id: 451657007791996929n }],
    settings,

    contextMenus: {
        "message"(children, { channel, message }: { channel: Channel; message: Message; }) {
            if (!channel || !message || (message as any).deleted) return;

            children.push(
                <Menu.MenuItem
                    id="vc-auto-react"
                    label="Auto React"
                    action={() => autoReact(channel, message)}
                />
            );
        }
    },

    start() {
        settings.store.emojiSlots.forEach(slot => slot.id ??= crypto.randomUUID());
    },
});
