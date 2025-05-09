import { parseNewBlock } from "@/features/typebot/helpers/parseNewBlock";
import { createId } from "@paralleldrive/cuid2";
import { blockHasItems } from "@typebot.io/blocks-core/helpers";
import type {
  Block,
  BlockIndices,
  BlockV6,
  BlockWithItems,
} from "@typebot.io/blocks-core/schemas/schema";
import type { HttpRequest } from "@typebot.io/blocks-integrations/httpRequest/schema";
import { byId } from "@typebot.io/lib/utils";
import type { Edge } from "@typebot.io/typebot/schemas/edge";
import type { Typebot, TypebotV6 } from "@typebot.io/typebot/schemas/typebot";
import { type Draft, produce } from "immer";
import type { SetTypebot } from "../TypebotProvider";
import { deleteConnectedEdgesDraft, deleteEdgeDraft } from "./edges";
import { duplicateItemDraft } from "./items";

export type BlocksActions = {
  createBlock: (
    block: BlockV6 | BlockV6["type"],
    indices: BlockIndices,
  ) => string | undefined;
  updateBlock: (
    indices: BlockIndices,
    updates: Partial<Omit<BlockV6, "id" | "type">>,
  ) => void;
  duplicateBlock: (indices: BlockIndices) => void;
  detachBlockFromGroup: (indices: BlockIndices) => void;
  deleteBlock: (indices: BlockIndices) => void;
};

export type WebhookCallBacks = {
  onWebhookBlockCreated: (data: Partial<HttpRequest>) => void;
  onWebhookBlockDuplicated: (
    existingWebhookId: string,
    newWebhookId: string,
  ) => void;
};

export const blocksAction = (setTypebot: SetTypebot): BlocksActions => ({
  createBlock: (block: BlockV6 | BlockV6["type"], indices: BlockIndices) => {
    let blockId;
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        blockId = createBlockDraft(typebot, block, indices);
      }),
    );
    return blockId;
  },
  updateBlock: (
    { groupIndex, blockIndex }: BlockIndices,
    updates: Partial<Omit<Block, "id" | "type">>,
  ) =>
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        if (!typebot.groups[groupIndex]?.blocks[blockIndex]) return;
        const block = typebot.groups[groupIndex].blocks[blockIndex];
        typebot.groups[groupIndex].blocks[blockIndex] = {
          ...block,
          ...updates,
        };
      }),
    ),
  duplicateBlock: ({ groupIndex, blockIndex }: BlockIndices) =>
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        const block = { ...typebot.groups[groupIndex].blocks[blockIndex] };
        const blocks = typebot.groups[groupIndex].blocks;
        const { newBlock, newEdges } = duplicateBlockDraft(block, {
          edges: typebot.edges,
        });
        if (blockIndex === blocks.length - 1 && block.outgoingEdgeId)
          deleteEdgeDraft({
            typebot,
            edgeId: block.outgoingEdgeId,
          });
        typebot.groups[groupIndex].blocks.splice(blockIndex + 1, 0, newBlock);
        if (newEdges) {
          newEdges.forEach((edge) => {
            typebot.edges.push(edge);
          });
        }
      }),
    ),
  detachBlockFromGroup: (indices: BlockIndices) =>
    setTypebot((typebot) => produce(typebot, removeBlockFromGroup(indices))),
  deleteBlock: ({ groupIndex, blockIndex }: BlockIndices) =>
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        const removingBlock = typebot.groups[groupIndex].blocks[blockIndex];
        deleteConnectedEdgesDraft(typebot, removingBlock.id);
        removeBlockFromGroup({ groupIndex, blockIndex })(typebot);
        removeEmptyGroups(typebot);
      }),
    ),
});

const removeBlockFromGroup =
  ({ groupIndex, blockIndex }: BlockIndices) =>
  (typebot: Draft<TypebotV6>) => {
    typebot.groups[groupIndex].blocks.splice(blockIndex, 1);
  };

export const createBlockDraft = (
  typebot: Draft<TypebotV6>,
  block: BlockV6 | BlockV6["type"],
  { groupIndex, blockIndex }: BlockIndices,
) => {
  const blocks = typebot.groups[groupIndex].blocks;
  if (
    blockIndex === blocks.length &&
    blockIndex > 0 &&
    blocks[blockIndex - 1].outgoingEdgeId
  )
    deleteEdgeDraft({
      typebot,
      edgeId: blocks[blockIndex - 1].outgoingEdgeId as string,
      groupIndex,
    });
  const blockId =
    typeof block === "string"
      ? createNewBlock(typebot, block, { groupIndex, blockIndex })
      : moveBlockToGroup(typebot, block, { groupIndex, blockIndex });
  removeEmptyGroups(typebot);
  return blockId;
};

const createNewBlock = (
  typebot: Draft<Typebot>,
  type: BlockV6["type"],
  { groupIndex, blockIndex }: BlockIndices,
) => {
  const newBlock = parseNewBlock(type);
  typebot.groups[groupIndex].blocks.splice(blockIndex ?? 0, 0, newBlock);
  return newBlock.id;
};

const moveBlockToGroup = (
  typebot: Draft<TypebotV6>,
  block: BlockV6,
  { groupIndex, blockIndex }: BlockIndices,
) => {
  const newBlock = { ...block };
  if (block.outgoingEdgeId) {
    if (typebot.groups[groupIndex].blocks.length > blockIndex) {
      deleteEdgeDraft({
        typebot,
        edgeId: block.outgoingEdgeId,
        groupIndex,
      });
      newBlock.outgoingEdgeId = undefined;
    } else {
      const edgeIndex = typebot.edges.findIndex(byId(block.outgoingEdgeId));
      if (edgeIndex === -1) newBlock.outgoingEdgeId = undefined;
    }
  }
  const groupId = typebot.groups[groupIndex].id;
  typebot.edges.forEach((edge) => {
    if (edge.to.blockId === block.id) {
      edge.to.groupId = groupId;
    }
  });
  typebot.groups[groupIndex].blocks.splice(blockIndex ?? 0, 0, newBlock);
};

export const duplicateBlockDraft = (
  block: Draft<BlockV6>,
  { edges }: { edges: Edge[] },
): { newBlock: BlockV6; newEdges?: Edge[] } => {
  const associatedEdge = block.outgoingEdgeId
    ? edges.find((edge) => edge.id === block.outgoingEdgeId)
    : undefined;
  const newBlockId = createId();
  const newDefaultOutgoingEdge = associatedEdge
    ? {
        ...associatedEdge,
        id: createId(),
        from: {
          blockId: newBlockId,
        },
      }
    : undefined;
  const newEdges: Edge[] = newDefaultOutgoingEdge
    ? [newDefaultOutgoingEdge]
    : [];

  if (blockHasItems(block)) {
    const newItems = block.items?.map((item) =>
      duplicateItemDraft(item, {
        blockType: block.type,
        blockId: newBlockId,
        edges,
      }),
    );
    newItems?.forEach((item) => {
      if (item.newEdges) newEdges.push(...item.newEdges);
    });
    return {
      newBlock: {
        ...block,
        id: newBlockId,
        items: newItems.map((item) => item.newItem),
        outgoingEdgeId: newDefaultOutgoingEdge?.id,
      } as BlockWithItems,
      newEdges,
    };
  }
  return {
    newBlock: {
      ...block,
      id: newBlockId,
      outgoingEdgeId: newDefaultOutgoingEdge?.id,
    },
    newEdges,
  };
};

export const deleteGroupDraft =
  (typebot: Draft<TypebotV6>) => (groupIndex: number) => {
    deleteConnectedEdgesDraft(typebot, typebot.groups[groupIndex].id);
    typebot.groups.splice(groupIndex, 1);
  };

export const removeEmptyGroups = (typebot: Draft<TypebotV6>) => {
  const emptyGroupsIndices = typebot.groups.reduce<number[]>(
    (arr, group, idx) => {
      group.blocks.length === 0 && arr.push(idx);
      return arr;
    },
    [],
  );
  emptyGroupsIndices.forEach(deleteGroupDraft(typebot));
};
