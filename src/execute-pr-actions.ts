import { MutationOptions } from "@apollo/client/core";
import * as schema from "@octokit/graphql-schema/schema";
import { PR_repository_pullRequest } from "./queries/schema/PR";
import { Actions, LabelNames, LabelName } from "./compute-pr-actions";
import { createMutation, client } from "./graphql-client";
import { getProjectBoardColumns, getLabels } from "./util/cachedQueries";
import { noNullish, flatten } from "./util/util";
import { tagsToDeleteIfNotPosted } from "./comments";
import * as comment from "./util/comment";

// https://github.com/DefinitelyTyped/DefinitelyTyped/projects/5
const ProjectBoardNumber = 5;

export async function executePrActions(repoId: string, actions: Actions, pr: PR_repository_pullRequest, dry?: boolean) {
    const botComments: ParsedComment[] = getBotComments(pr);
    const mutations = noNullish([
        ...await getMutationsForLabels(actions, pr),
        ...await getMutationsForProjectChanges(actions, pr),
        ...getMutationsForComments(actions, pr.id, botComments),
        ...getMutationsForCommentRemovals(actions, botComments),
        ...getMutationsForChangingPRState(actions, pr),
        ...getMutationsForReRunningCI(repoId, actions),
    ]);
    if (!dry) {
        // Perform mutations one at a time
        for (const mutation of mutations)
            await client.mutate(mutation as MutationOptions<void, typeof mutations[number]["variables"]>);
    }
    return mutations;
}

async function getMutationsForLabels(actions: Actions, pr: PR_repository_pullRequest) {
    if (!actions.shouldUpdateLabels) return [];
    const labels = noNullish(pr.labels?.nodes).map(l => l.name);
    const makeMutations = async (pred: (l: LabelName) => boolean, query: keyof schema.Mutation) => {
        const labels = LabelNames.filter(pred);
        return labels.length === 0 ? null
            : createMutation<schema.AddLabelsToLabelableInput & schema.RemoveLabelsFromLabelableInput>(query, {
                labelIds: await Promise.all(labels.map(label => getLabelIdByName(label))),
                labelableId: pr.id });
    };
    return Promise.all([
        makeMutations((label => !labels.includes(label) && actions.labels.includes(label)), "addLabelsToLabelable"),
        makeMutations((label => labels.includes(label) && !actions.labels.includes(label)), "removeLabelsFromLabelable"),
    ]);
}

async function getMutationsForProjectChanges(actions: Actions, pr: PR_repository_pullRequest) {
    if (!actions.projectColumn) return [];
    const card = pr.projectCards.nodes?.find(card => card?.project.number === ProjectBoardNumber);
    if (actions.projectColumn === "*REMOVE*") {
        if (!card || card.column?.name === "Recently Merged") return [];
        return [createMutation<schema.DeleteProjectCardInput>("deleteProjectCard", { cardId: card.id })];
    }
    // Existing card is ok => do nothing
    if (card?.column?.name === actions.projectColumn) return [];
    const columnId = await getProjectBoardColumnIdByName(actions.projectColumn);
    return [card
            // Move existing card
            ? createMutation<schema.MoveProjectCardInput>("moveProjectCard", { cardId: card.id, columnId })
            // No existing card => create a new one
            : createMutation<schema.AddProjectCardInput>("addProjectCard", { contentId: pr.id, projectColumnId: columnId })];
}

type ParsedComment = { id: string, body: string, tag: string, status: string };

function getBotComments(pr: PR_repository_pullRequest): ParsedComment[] {
    return noNullish(
        (pr.comments.nodes ?? [])
            .filter(comment => comment?.author?.login === "typescript-bot")
            .map(c => {
                const { id, body } = c!, parsed = comment.parse(body);
                return parsed && { id, body, ...parsed };
            }));
}

function getMutationsForComments(actions: Actions, prId: string, botComments: ParsedComment[]) {
    return flatten(actions.responseComments.map(wantedComment => {
        const sameTagComments = botComments.filter(comment => comment.tag === wantedComment.tag);
        return sameTagComments.length === 0
            ? [createMutation<schema.AddCommentInput>("addComment", {
                subjectId: prId, body: comment.make(wantedComment) })]
            : sameTagComments.map(actualComment =>
                (actualComment.status === wantedComment.status) ? null // Comment is up-to-date; skip
                : createMutation<schema.UpdateIssueCommentInput>("updateIssueComment", {
                    id: actualComment.id,
                    body: comment.make(wantedComment) }));
    }));
}

function getMutationsForCommentRemovals(actions: Actions, botComments: ParsedComment[]) {
    const ciTagToKeep = actions.responseComments.find(c => c.tag.startsWith("ci-complaint"))?.tag;
    const postedTags = actions.responseComments.map(c => c.tag);
    return botComments.map(comment => {
        const { tag, id } = comment;
        const del = () => createMutation<schema.DeleteIssueCommentInput>("deleteIssueComment", { id });
        // Remove stale CI 'your build is green' notifications
        if (tag.includes("ci-") && tag !== ciTagToKeep) return del();
        // tags for comments that should be removed when not included in the actions
        if (tagsToDeleteIfNotPosted.includes(tag) && !postedTags.includes(tag)) return del();
        return null;
    });
}

function getMutationsForChangingPRState(actions: Actions, pr: PR_repository_pullRequest) {
    return [
        actions.shouldMerge
            ? createMutation<schema.MergePullRequestInput>("mergePullRequest", {
                commitHeadline: `🤖 Merge PR #${pr.number} ${pr.title} by @${pr.author?.login ?? "(ghost)"}`,
                expectedHeadOid: pr.headRefOid,
                mergeMethod: "SQUASH",
                pullRequestId: pr.id,
            })
            : null,
        actions.shouldClose
            ? createMutation<schema.ClosePullRequestInput>("closePullRequest", { pullRequestId: pr.id })
            : null,
    ];
}


function getMutationsForReRunningCI(repoId: string, actions: Actions) {
    return [
        actions.reRunActionsCheckSuiteID
            ? createMutation<schema.RerequestCheckSuiteInput>("rerequestCheckSuite", { checkSuiteId: actions.reRunActionsCheckSuiteID, repositoryId: repoId })
            : null,
    ];
}

async function getProjectBoardColumnIdByName(name: string): Promise<string> {
    const columns = await getProjectBoardColumns();
    const res = columns.find(e => e.name === name)?.id;
    if (!res) throw new Error(`No project board column named "${name}" exists`);
    return res;
}

async function getLabelIdByName(name: string): Promise<string> {
    const labels = await getLabels();
    const res = labels.find(l => l.name === name)?.id;
    if (!res) throw new Error(`No label named "${name}" exists`);
    return res;
}
