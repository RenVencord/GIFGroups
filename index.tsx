import * as DataStore from "@api/DataStore";
import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { Flex } from "@components/Flex";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { chooseFile, saveFile } from "@utils/web";
import { findByPropsLazy } from "@webpack";
import { Button, ConfirmModal, ContextMenuApi, FluxDispatcher, Menu, React, Text, openModal, showToast, useState } from "@webpack/common";
import type { NavContextMenuPatchCallback } from "@api/ContextMenu";

const GIFMediaTypes = findByPropsLazy("TL");

const getFormat = (isVid: boolean): any => {
    const TL = GIFMediaTypes?.TL;
    if (TL) {
        return isVid ? TL.VIDEO : TL.IMAGE;
    }
    return isVid ? 2 : 1;
};


interface GifItem {
    id?: string;
    url: string;
    src: string;
    gifSrc?: string;
    width: number;
    height: number;
    format: string;
}

interface GifGroup {
    id: string;
    name: string;
    gifs: GifItem[];
}


const DATA_KEY = "GifGroups_data";
const ORDER_KEY = "GifGroups_order";
const GROUP_PREFIX = "GifGroups_";
const FALLBACK_SRC = "https://media.giphy.com/media/1TOSaJsWtnhe0/giphy.gif";


let groups: Record<string, GifGroup> = {};
let groupOrder: string[] = [];
let dragGroupId: string | null = null;

// listeners registered by useGroupTiles; called after any mutation
const groupListeners = new Set<() => void>();

function notifyGroupChange() {
    groupListeners.forEach(fn => fn());
}


const loadGroups = async () => {
    groups = (await DataStore.get<Record<string, GifGroup>>(DATA_KEY)) ?? {};
    groupOrder = (await DataStore.get<string[]>(ORDER_KEY)) ?? Object.keys(groups);
    groupOrder = groupOrder.filter(id => id in groups);
    for (const id of Object.keys(groups))
        if (!groupOrder.includes(id)) groupOrder.push(id);
};

const saveGroups = async () => {
    await DataStore.set(DATA_KEY, groups);
    await DataStore.set(ORDER_KEY, groupOrder);
};


const genId = () => Math.random().toString(36).slice(2, 9);
const gifKey = (g: GifItem) => g.id ?? g.src;
const orderedGroups = () => groupOrder.map(id => groups[id]).filter(Boolean) as GifGroup[];

const createGroup = async (name: string): Promise<GifGroup> => {
    const group: GifGroup = { id: genId(), name, gifs: [] };
    groups[group.id] = group;
    groupOrder.push(group.id);
    await saveGroups();
    notifyGroupChange();
    return group;
};

const renameGroup = async (groupId: string, name: string) => {
    if (!groups[groupId]) return;
    groups[groupId].name = name;
    await saveGroups();
    notifyGroupChange();
};

const deleteGroup = async (groupId: string) => {
    delete groups[groupId];
    groupOrder = groupOrder.filter(id => id !== groupId);
    await saveGroups();
    notifyGroupChange();
};

const addToGroup = async (groupId: string, gif: GifItem) => {
    const g = groups[groupId];
    if (!g) return;

    let src = gif.src || gif.url || FALLBACK_SRC;
    if (typeof src === "string" && src.startsWith("//")) src = "https:" + src;

    let url = gif.url || src;
    if (typeof url === "string" && url.startsWith("//")) url = "https:" + url;

    let gifSrc = gif.gifSrc;
    if (typeof gifSrc === "string" && gifSrc.startsWith("//")) gifSrc = "https:" + gifSrc;

    const isVid = (gif.format as any) === "VIDEO" || (gif.format as any) === 2 ||
        (typeof src === "string" && (src.includes(".webm") || src.includes(".mp4")));

    const format = getFormat(isVid);

    const normalizedGif: GifItem = {
        id: gif.id || genId(),
        src,
        url,
        gifSrc,
        width: typeof gif.width === "number" && gif.width > 0 ? gif.width : (Number(gif.width) > 0 ? Number(gif.width) : 200),
        height: typeof gif.height === "number" && gif.height > 0 ? gif.height : (Number(gif.height) > 0 ? Number(gif.height) : 200),
        format,
    };

    if (!g.gifs.some(x => gifKey(x) === gifKey(normalizedGif))) {
        g.gifs.push(normalizedGif);
        await saveGroups();
        notifyGroupChange();
    }
};

const removeFromGroup = async (groupId: string, key: string) => {
    const g = groups[groupId];
    if (!g) return;
    g.gifs = g.gifs.filter(x => gifKey(x) !== key);
    await saveGroups();
    notifyGroupChange();
};

const reorderGroup = async (fromId: string, toId: string) => {
    const fi = groupOrder.indexOf(fromId);
    const ti = groupOrder.indexOf(toId);
    if (fi < 0 || ti < 0 || fi === ti) return;
    groupOrder.splice(fi, 1);
    groupOrder.splice(ti, 0, fromId);
    await saveGroups();
    notifyGroupChange();
};

const groupFromRt = (rt: string): GifGroup | null =>
    rt?.startsWith(GROUP_PREFIX)
        ? (groups[rt.slice(GROUP_PREFIX.length)] ?? null)
        : null;


const exportGroups = async () => {
    try {
        const data = JSON.stringify({ groups, groupOrder }, null, 2);
        const filename = `gif-groups-backup-${new Date().toISOString().slice(0, 10)}.json`;
        if (typeof IS_DISCORD_DESKTOP !== "undefined" && IS_DISCORD_DESKTOP && typeof DiscordNative !== "undefined" && DiscordNative?.fileManager?.saveWithDialog) {
            const encoded = new TextEncoder().encode(data);
            await DiscordNative.fileManager.saveWithDialog(encoded, filename);
        } else {
            saveFile(new File([data], filename, { type: "application/json" }));
        }
        showToast({ text: "Successfully exported GIF groups!", variant: "success" });
    } catch (err: any) {
        showToast({ text: `Failed to export GIF groups: ${err?.message ?? err}`, variant: "critical" });
    }
};

const importGroups = async () => {
    try {
        let fileContent = "";
        if (typeof IS_DISCORD_DESKTOP !== "undefined" && IS_DISCORD_DESKTOP && typeof DiscordNative !== "undefined" && DiscordNative?.fileManager?.openFiles) {
            const [file] = await DiscordNative.fileManager.openFiles({
                filters: [
                    { name: "GIF Groups Backup", extensions: ["json"] },
                    { name: "All Files", extensions: ["*"] }
                ]
            });
            if (!file) return;
            fileContent = new TextDecoder().decode(file.data);
        } else {
            const file = await chooseFile("application/json");
            if (!file) return;
            fileContent = await file.text();
        }

        const parsed = JSON.parse(fileContent);
        if (!parsed || typeof parsed !== "object") {
            throw new Error("Invalid backup format");
        }

        let importedGroups: Record<string, GifGroup> = {};
        let importedOrder: string[] = [];

        if (parsed.groups && typeof parsed.groups === "object" && !Array.isArray(parsed.groups)) {
            importedGroups = parsed.groups;
            importedOrder = Array.isArray(parsed.groupOrder) ? parsed.groupOrder : Object.keys(importedGroups);
        } else if (Array.isArray(parsed.groups)) {
            for (const g of parsed.groups) {
                if (g && typeof g === "object" && g.id) {
                    importedGroups[g.id] = g;
                }
            }
            importedOrder = Array.isArray(parsed.groupOrder) ? parsed.groupOrder : parsed.groups.map((g: any) => g.id).filter(Boolean);
        } else if (Array.isArray(parsed)) {
            for (const g of parsed) {
                if (g && typeof g === "object" && g.id) {
                    importedGroups[g.id] = g;
                }
            }
            importedOrder = parsed.map((g: any) => g.id).filter(Boolean);
        } else {
            const keys = Object.keys(parsed).filter(k => k !== "groupOrder");
            if (keys.length > 0 && typeof parsed[keys[0]] === "object" && parsed[keys[0]].gifs) {
                importedGroups = parsed;
                importedOrder = Array.isArray(parsed.groupOrder) ? parsed.groupOrder : keys;
            } else {
                throw new Error("Unrecognized GIF groups backup format");
            }
        }

        for (const [id, group] of Object.entries(importedGroups)) {
            if (!group || typeof group !== "object" || typeof group.name !== "string" || !Array.isArray(group.gifs)) {
                throw new Error(`Invalid group structure in group "${id}"`);
            }
        }

        groups = importedGroups;
        groupOrder = importedOrder.filter(id => id in groups);
        for (const id of Object.keys(groups)) {
            if (!groupOrder.includes(id)) groupOrder.push(id);
        }

        await saveGroups();
        notifyGroupChange();
        showToast({ text: "Successfully imported GIF groups!", variant: "success" });
    } catch (err: any) {
        showToast({ text: `Failed to import GIF groups: ${err?.message ?? err}`, variant: "critical" });
    }
};


function NameModal({
    title,
    initial = "",
    confirmText,
    onConfirm,
    onClose,
    ...props
}: {
    title: string;
    initial?: string;
    confirmText: string;
    onConfirm: (name: string) => void;
    onClose: () => void;
    [k: string]: any;
}) {
    const [name, setName] = useState(initial);

    const submit = () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        onConfirm(trimmed);
        onClose();
    };

    return (
        <ConfirmModal
            {...props}
            title={title}
            confirmText={confirmText}
            cancelText="Cancel"
            onConfirm={submit}
        >
            <input
                style={{
                    width: "100%",
                    padding: "8px",
                    marginTop: 12,
                    borderRadius: 4,
                    background: "var(--input-background)",
                    border: "1px solid var(--background-modifier-accent)",
                    color: "var(--text-normal)",
                    fontSize: 16,
                    outline: "none",
                    boxSizing: "border-box",
                }}
                autoFocus
                placeholder="Group name"
                value={name}
                onChange={e => setName(e.currentTarget.value)}
                onKeyDown={e => e.key === "Enter" && submit()}
            />
        </ConfirmModal>
    );
}

function openNewGroupModal(gif: GifItem) {
    openModal(props => (
        <NameModal
            {...props}
            title="New GIF Group"
            confirmText="Create"
            onConfirm={async name => {
                const group = await createGroup(name);
                await addToGroup(group.id, gif);
            }}
        />
    ));
}

function openRenameModal(group: GifGroup) {
    openModal(props => (
        <NameModal
            {...props}
            title="Rename Group"
            initial={group.name}
            confirmText="Rename"
            onConfirm={name => renameGroup(group.id, name)}
        />
    ));
}


function closeMenu() {
    FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" });
}

function buildGifMenu(item: GifItem) {
    const all = orderedGroups();
    const key = gifKey(item);

    return (
        <Menu.Menu navId="gif-groups-ctx" onClose={closeMenu}>
            <Menu.MenuGroup label="GIF Groups">
                {all.map(g => {
                    const inGroup = g.gifs.some(x => gifKey(x) === key);
                    return (
                        <Menu.MenuItem
                            key={g.id}
                            id={`gg-toggle-${g.id}`}
                            label={g.name}
                            color={inGroup ? "danger" : undefined}
                            action={() => inGroup
                                ? removeFromGroup(g.id, key)
                                : addToGroup(g.id, item)
                            }
                        />
                    );
                })}
                {all.length > 0 && <Menu.MenuSeparator />}
                <Menu.MenuItem
                    id="gg-new"
                    label="New group..."
                    action={() => openNewGroupModal(item)}
                />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

function buildGroupTileMenu(group: GifGroup) {
    return (
        <Menu.Menu navId="gif-groups-tile-ctx" onClose={closeMenu}>
            <Menu.MenuGroup label={group.name}>
                <Menu.MenuItem
                    id="gg-rename"
                    label="Rename"
                    action={() => openRenameModal(group)}
                />
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="gg-delete"
                    label="Delete group"
                    color="danger"
                    action={() => deleteGroup(group.id)}
                />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}


function gifItemFromChatCtxArgs(args: any[]): GifItem | null {
    const item = args[0];
    if (!item) return null;
    let src = item.src ?? item.url ?? item.href;
    if (!src) return null;
    if (typeof src === "string" && src.startsWith("//")) src = "https:" + src;

    let url = item.url ?? src;
    if (typeof url === "string" && url.startsWith("//")) url = "https:" + url;

    let gifSrc = item.gifSrc;
    if (typeof gifSrc === "string" && gifSrc.startsWith("//")) gifSrc = "https:" + gifSrc;

    const isVid = item.contentType?.includes("video") || (item.format as any) === "VIDEO" || item.format === 2 ||
        (typeof src === "string" && (src.includes(".webm") || src.includes(".mp4")));

    const format = getFormat(isVid);

    const result = {
        url,
        src,
        gifSrc,
        width: typeof item.width === "number" && item.width > 0 ? item.width : (Number(item.width) > 0 ? Number(item.width) : 200),
        height: typeof item.height === "number" && item.height > 0 ? item.height : (Number(item.height) > 0 ? Number(item.height) : 200),
        format,
    };
    console.log("[GIFGroups] raw item from ctx:", JSON.stringify(item));
    console.log("[GIFGroups] gifItemFromChatCtxArgs result:", JSON.stringify(result));
    return result;
}

const chatGifMenuPatch: NavContextMenuPatchCallback = (children, ...args) => {
    const gif = gifItemFromChatCtxArgs(args);
    if (!gif) return;

    const all = orderedGroups();
    const key = gifKey(gif);

    children.push(
        <Menu.MenuItem key="gif-groups" id="gif-groups" label="GIF Groups">
            {all.map(g => {
                const inGroup = g.gifs.some(x => gifKey(x) === key);
                return (
                    <Menu.MenuItem
                        key={g.id}
                        id={`gg-chat-toggle-${g.id}`}
                        label={g.name}
                        color={inGroup ? "danger" : undefined}
                        action={() => inGroup
                            ? removeFromGroup(g.id, key)
                            : addToGroup(g.id, gif)
                        }
                    />
                );
            })}
            {all.length > 0 && <Menu.MenuSeparator />}
            <Menu.MenuItem
                id="gg-chat-new"
                label="New group..."
                action={() => openNewGroupModal(gif)}
            />
        </Menu.MenuItem>
    );
};


export default definePlugin({
    name: "GIFGroups",
    description: "Organise GIFs into custom groups in the GIF picker",
    authors: [{ name: "ren", id: 163734654040539136n }],

    async start() {
        await loadGroups();
        addContextMenuPatch(["image-menu", "image-context"], chatGifMenuPatch);
    },

    stop() {
        removeContextMenuPatch(["image-menu", "image-context"], chatGifMenuPatch);
    },

    settingsAboutComponent: () => (
        <Flex gap="1em">
            <Button onClick={exportGroups}>
                Export Groups
            </Button>
            <Button color={Button.Colors.PRIMARY} onClick={importGroups}>
                Import Groups
            </Button>
        </Flex>
    ),

    // ── Methods called from patches ──────────────────────────────────────

    onGifContextMenu(event: MouseEvent, item: any) {
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();

        const tileGroup = typeof item.type === "string" && item.type.startsWith(GROUP_PREFIX)
            ? groupFromRt(item.type)
            : null;

        if (tileGroup) {
            ContextMenuApi.openContextMenu(event, () => buildGroupTileMenu(tileGroup));
        } else {
            ContextMenuApi.openContextMenu(event, () => buildGifMenu(item as GifItem));
        }
    },

    isGroupItem(item: any): boolean {
        return typeof item?.type === "string" && item.type.startsWith(GROUP_PREFIX);
    },

    onGroupDragStart(e: DragEvent, item: any) {
        if (!this.isGroupItem(item)) return;
        dragGroupId = (item as any).type.slice(GROUP_PREFIX.length);
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", dragGroupId);
        }
    },

    onGroupDragEnd(_e: DragEvent) {
        dragGroupId = null;
    },

    onGroupDragOver(e: DragEvent, item: any) {
        if (!dragGroupId || !this.isGroupItem(item)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    },

    async onGroupDrop(e: DragEvent, item: any) {
        e.preventDefault();
        if (!dragGroupId || !this.isGroupItem(item)) return;
        const fromId = dragGroupId;
        const toId = (item as any).type.slice(GROUP_PREFIX.length);
        dragGroupId = null;
        await reorderGroup(fromId, toId);
    },

    get groups() {
        return groups;
    },

    get groupOrder() {
        return groupOrder;
    },

    // React hook — called inside j() (the category grid wrapper) via patch 2a.
    // Subscribes the component to group mutations so it re-renders live.
    useGroupTiles() {
        const [, rerender] = React.useReducer((x: number) => x + 1, 0);
        React.useEffect(() => {
            groupListeners.add(rerender);
            return () => void groupListeners.delete(rerender);
        }, []);
        return this.buildGroupTiles();
    },

    buildGroupTiles(): object[] {
        return orderedGroups().map(g => {
            const gif = g.gifs.length
                ? g.gifs[Math.floor(Math.random() * g.gifs.length)]
                : null;
            let src = gif?.src ?? FALLBACK_SRC;
            if (typeof src === "string" && src.startsWith("//")) src = "https:" + src;

            const isVid = (gif?.format as any) === "VIDEO" || (gif?.format as any) === 2 ||
                (typeof src === "string" && (src.includes(".webm") || src.includes(".mp4")));

            const format = getFormat(isVid);

            return {
                type: `${GROUP_PREFIX}${g.id}`,
                name: g.name,
                src,
                format,
            };
        });
    },

    isGroupRt(rt: unknown): boolean {
        return typeof rt === "string" && rt.startsWith(GROUP_PREFIX);
    },

    // newest first
    getGroupGifs(rt: string): GifItem[] {
        const rawGifs = groupFromRt(rt)?.gifs ?? [];
        const gifs = [...rawGifs].reverse().map(g => {
            let src = g.src || g.url || FALLBACK_SRC;
            if (typeof src === "string" && src.startsWith("//")) src = "https:" + src;

            let url = g.url || src;
            if (typeof url === "string" && url.startsWith("//")) url = "https:" + url;

            let gifSrc = g.gifSrc;
            if (typeof gifSrc === "string" && gifSrc.startsWith("//")) gifSrc = "https:" + gifSrc;

            const isVid = (g.format as any) === "VIDEO" || (g.format as any) === 2 ||
                (typeof src === "string" && (src.includes(".webm") || src.includes(".mp4")));

            const format = getFormat(isVid);

            return {
                ...g,
                id: g.id || gifKey(g),
                src,
                url,
                gifSrc,
                width: typeof g.width === "number" && g.width > 0 ? g.width : (Number(g.width) > 0 ? Number(g.width) : 200),
                height: typeof g.height === "number" && g.height > 0 ? g.height : (Number(g.height) > 0 ? Number(g.height) : 200),
                format,
            };
        });
        console.log("[GIFGroups] getGroupGifs for", rt, "returning", gifs.length, "items:", JSON.stringify(gifs));
        return gifs;
    },

    groupHeaderContent(rt: string, color: string) {
        const group = groupFromRt(rt);
        return React.createElement(Text, {
            variant: "heading-md/semibold",
            color,
            children: group?.name ?? "Group",
        });
    },

    patches: [
        {
            find: "handleCanPlay=",
            replacement: {
                match: /onClick:this\.handleClick/,
                replace: "onContextMenu:e=>$self.onGifContextMenu(e,this.props.item),draggable:$self.isGroupItem(this.props.item)||void 0,onDragStart:e=>$self.onGroupDragStart(e,this.props.item),onDragEnd:e=>$self.onGroupDragEnd(e),onDragOver:e=>$self.onGroupDragOver(e,this.props.item),onDrop:e=>$self.onGroupDrop(e,this.props.item),onClick:this.handleClick",
            },
        },
        {
            find: "renderHeaderContent(){",
            replacement: [
                {
                    // use useGroupTiles (a hook) so rename/reorder/delete live-updates the grid
                    match: /trendingCategories:(\i),favorites:/,
                    replace: "trendingCategories:[...$self.useGroupTiles(),...$1],favorites:",
                },
                {
                    match: /data:(\i)(===(?:\i\.)+FAVORITES)\?/,
                    replace: "data:$self.isGroupRt($1)?$self.getGroupGifs($1):$1$2?",
                },
                {
                    match: /renderHeaderContent\(\)\{/,
                    replace: "renderHeaderContent(){if($self.isGroupRt(this.state.resultType))return $self.groupHeaderContent(this.state.resultType,this.props.headingColor);",
                },
            ],
        },
    ],
});