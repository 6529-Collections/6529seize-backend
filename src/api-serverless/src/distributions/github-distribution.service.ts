import fetch from 'node-fetch';
import { env } from '../../../env';
import { Logger } from '../../../logging';

interface PhotoUpload {
  fileName: string;
  content: Buffer;
}

interface PhaseCsvFiles {
  phaseIndex: number;
  phaseName: string;
  airdropsCsv: string;
  allowlistsCsv: string;
}

interface GitHubFileInfo {
  name: string;
  path: string;
  sha: string;
  type: 'file' | 'dir';
}

export class GitHubDistributionService {
  private readonly logger = Logger.get(this.constructor.name);
  private readonly owner = '6529-Collections';
  private readonly repo = 'thememecards';
  private readonly branch = 'main';

  private getToken(): string {
    return env.getStringOrThrow('GH_MEMECARDS_TOKEN');
  }

  private getCommitterInfo() {
    return {
      name:
        env.getStringOrNull('GH_MEMECARDS_COMMITTER_NAME') ??
        '6529 Distribution Bot',
      email:
        env.getStringOrNull('GH_MEMECARDS_COMMITTER_EMAIL') ??
        'distribution@6529.io'
    };
  }

  async uploadDistributionFiles(
    cardId: number,
    photos: PhotoUpload[],
    airdropFinalCsv: string,
    phaseCsvFiles: PhaseCsvFiles[]
  ): Promise<{ uploadedFiles: string[]; deletedFiles: string[] }> {
    const folderPath = `card${cardId}`;
    const committer = this.getCommitterInfo();

    const existingFiles = await this.listFolderContents(folderPath);
    const deletedFiles: string[] = [];

    if (existingFiles.length > 0) {
      this.logger.info(
        `Found ${existingFiles.length} existing files in ${folderPath}, deleting...`
      );
      for (const file of existingFiles) {
        if (file.type === 'file') {
          await this.deleteFile(
            file.path,
            file.sha,
            `Remove ${file.name} for card ${cardId} replacement`,
            committer
          );
          deletedFiles.push(file.path);
        }
      }
      this.logger.info(
        `Deleted ${deletedFiles.length} files from ${folderPath}`
      );
    }

    const uploadedFiles: string[] = [];

    for (const photo of photos) {
      const filePath = `${folderPath}/${photo.fileName}`;
      await this.createFile(
        filePath,
        photo.content.toString('base64'),
        `Add ${photo.fileName} for card ${cardId}`,
        committer
      );
      uploadedFiles.push(filePath);
    }

    const airdropPath = `${folderPath}/airdrop_final.csv`;
    await this.createFile(
      airdropPath,
      Buffer.from(airdropFinalCsv).toString('base64'),
      `Add airdrop_final.csv for card ${cardId}`,
      committer
    );
    uploadedFiles.push(airdropPath);

    for (const phaseCsv of phaseCsvFiles) {
      if (phaseCsv.airdropsCsv.length > 0) {
        const airdropPath = `${folderPath}/phase_${phaseCsv.phaseIndex}_airdrops.csv`;
        await this.createFile(
          airdropPath,
          Buffer.from(phaseCsv.airdropsCsv).toString('base64'),
          `Add phase_${phaseCsv.phaseIndex}_airdrops.csv for card ${cardId}`,
          committer
        );
        uploadedFiles.push(airdropPath);
      }

      if (phaseCsv.allowlistsCsv.length > 0) {
        const allowlistPath = `${folderPath}/phase_${phaseCsv.phaseIndex}_allowlists.csv`;
        await this.createFile(
          allowlistPath,
          Buffer.from(phaseCsv.allowlistsCsv).toString('base64'),
          `Add phase_${phaseCsv.phaseIndex}_allowlists.csv for card ${cardId}`,
          committer
        );
        uploadedFiles.push(allowlistPath);
      }
    }

    return { uploadedFiles, deletedFiles };
  }

  private async listFolderContents(
    folderPath: string
  ): Promise<GitHubFileInfo[]> {
    const token = this.getToken();
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${folderPath}?ref=${this.branch}`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json'
      }
    });

    if (resp.status === 404) {
      this.logger.info(`Folder ${folderPath} does not exist yet`);
      return [];
    }

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(
        `Failed to list folder ${folderPath}: ${resp.status} - ${errorText}`
      );
    }

    const contents = (await resp.json()) as GitHubFileInfo[];
    return contents;
  }

  private async deleteFile(
    path: string,
    sha: string,
    message: string,
    committer: { name: string; email: string }
  ): Promise<void> {
    const token = this.getToken();
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;

    const body = {
      message,
      sha,
      branch: this.branch,
      committer
    };

    const resp = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(
        `Failed to delete ${path}: ${resp.status} - ${errorText}`
      );
    }

    this.logger.info(`Deleted ${path} from GitHub`);
  }

  private async createFile(
    path: string,
    contentBase64: string,
    message: string,
    committer: { name: string; email: string }
  ): Promise<void> {
    const token = this.getToken();
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;

    const body = {
      message,
      content: contentBase64,
      branch: this.branch,
      committer
    };

    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(
        `Failed to upload ${path}: ${resp.status} - ${errorText}`
      );
    }

    this.logger.info(`Successfully uploaded ${path} to GitHub`);
  }
}

export const githubDistributionService = new GitHubDistributionService();
