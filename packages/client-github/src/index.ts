import { Octokit } from "@octokit/rest";
import { glob } from "glob";
import simpleGit, { SimpleGit } from "simple-git";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { createHash } from "crypto";
import {
    elizaLogger,
    AgentRuntime,
    Client,
    IAgentRuntime,
    Content,
    Memory,
    stringToUuid,
    embeddingZeroVector,
    splitChunks,
    embed,
} from "@ai16z/eliza";

export interface GitHubConfig {
    owner: string;
    repo: string;
    branch?: string;
    path?: string;
    token: string;
}

export class GitHubClient {
    private octokit: Octokit;
    private git: SimpleGit;
    private config: GitHubConfig;
    private runtime: AgentRuntime;
    private repoPath: string;

    constructor(runtime: AgentRuntime) {
        this.runtime = runtime;
        this.config = {
            owner: runtime.getSetting("GITHUB_OWNER") as string,
            repo: runtime.getSetting("GITHUB_REPO") as string,
            branch: runtime.getSetting("GITHUB_BRANCH") as string,
            path: runtime.getSetting("GITHUB_PATH") as string,
            token: runtime.getSetting("GITHUB_API_TOKEN") as string,
        };
        this.octokit = new Octokit({ auth: this.config.token });
        this.git = simpleGit();
        this.repoPath = path.join(
            process.cwd(),
            ".repos",
            this.config.owner,
            this.config.repo
        );
    }

    async initialize() {
        // Create repos directory if it doesn't exist
        await fs.mkdir(path.join(process.cwd(), ".repos", this.config.owner), {
            recursive: true,
        });

        // Clone or pull repository
        if (!existsSync(this.repoPath)) {
            await this.git.clone(
                `https://github.com/${this.config.owner}/${this.config.repo}.git`,
                this.repoPath
            );
        } else {
            const git = simpleGit(this.repoPath);
            await git.pull();
        }

        // Checkout specified branch if provided
        if (this.config.branch) {
            const git = simpleGit(this.repoPath);
            await git.checkout(this.config.branch);
        }
    }

    async createMemoriesFromFiles() {
        console.log("Create memories");
        const searchPath = this.config.path
            ? path.join(this.repoPath, this.config.path, "**/*")
            : path.join(this.repoPath, "**/*");

        const files = await glob(searchPath, { nodir: true });

        for (const file of files) {
            const relativePath = path.relative(this.repoPath, file);
            const content = await fs.readFile(file, "utf-8");
            const contentHash = createHash("sha256")
                .update(content)
                .digest("hex");
            const knowledgeId = stringToUuid(
                `github-${this.config.owner}-${this.config.repo}-${relativePath}`
            );

            const existingDocument =
                await this.runtime.documentsManager.getMemoryById(knowledgeId);

            if (
                existingDocument &&
                existingDocument.content["hash"] == contentHash
            ) {
                continue;
            }

            console.log(
                "Processing knowledge for ",
                this.runtime.character.name,
                " - ",
                relativePath
            );

            const memory: Memory = {
                id: knowledgeId,
                agentId: this.runtime.agentId,
                userId: this.runtime.agentId,
                roomId: this.runtime.agentId,
                content: {
                    text: content,
                    hash: contentHash,
                    source: "github",
                    attachments: [],
                    metadata: {
                        path: relativePath,
                        repo: this.config.repo,
                        owner: this.config.owner,
                    },
                },
                embedding: embeddingZeroVector,
            };

            await this.runtime.documentsManager.createMemory(memory);

            // Only split if content exceeds 4000 characters
            const fragments =
                content.length > 4000
                    ? await splitChunks(content, 2000, 200)
                    : [content];

            for (const fragment of fragments) {
                // Skip empty fragments
                if (!fragment.trim()) continue;

                // Add file path context to the fragment before embedding
                const fragmentWithPath = `File: ${relativePath}\n\n${fragment}`;
                const embedding = await embed(this.runtime, fragmentWithPath);

                await this.runtime.knowledgeManager.createMemory({
                    // We namespace the knowledge base uuid to avoid id
                    // collision with the document above.
                    id: stringToUuid(knowledgeId + fragment),
                    roomId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    userId: this.runtime.agentId,
                    content: {
                        source: knowledgeId,
                        text: fragment,
                    },
                    embedding,
                });
            }
        }
    }

    async createPullRequest(
        title: string,
        branch: string,
        files: Array<{ path: string; content: string }>,
        description?: string
    ) {
        // Create new branch
        const git = simpleGit(this.repoPath);
        await git.checkout(["-b", branch]);

        // Write files
        for (const file of files) {
            const filePath = path.join(this.repoPath, file.path);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, file.content);
        }

        // Commit and push changes
        await git.add(".");
        await git.commit(title);
        await git.push("origin", branch);

        // Create PR
        const pr = await this.octokit.pulls.create({
            owner: this.config.owner,
            repo: this.config.repo,
            title,
            body: description || title,
            head: branch,
            base: this.config.branch || "main",
        });

        return pr.data;
    }

    async createCommit(
        message: string,
        files: Array<{ path: string; content: string }>
    ) {
        const git = simpleGit(this.repoPath);

        // Write files
        for (const file of files) {
            const filePath = path.join(this.repoPath, file.path);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, file.content);
        }

        // Commit and push changes
        await git.add(".");
        await git.commit(message);
        await git.push();
    }
}

export const GitHubClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        elizaLogger.log("GitHubClientInterface start");

        const client = new GitHubClient(runtime as AgentRuntime);
        await client.initialize();
        await client.createMemoriesFromFiles();

        return client;
    },
    stop: async (runtime: IAgentRuntime) => {
        elizaLogger.log("GitHubClientInterface stop");
    },
};

export default GitHubClientInterface;