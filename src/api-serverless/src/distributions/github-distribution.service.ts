import fetch, { RequestInit as NodeFetchRequestInit } from 'node-fetch';
import { PDFDocument } from 'pdf-lib';
import { env } from '../../../env';
import { BadRequestException } from '../../../exceptions';
import { Logger } from '../../../logging';
import {
  fetchDistributionAirdrops,
  fetchDistributionOverview,
  fetchDistributionPhotos,
  fetchDistributionsByPhase,
  PhaseDistributionData
} from './api.distributions.db';

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

const API_BASE = 'https://api.github.com/repos';

export class GitHubDistributionService {
  private readonly logger = Logger.get(this.constructor.name);
  private readonly owner = '6529-Collections';
  private readonly repo = 'thememecards';
  private readonly branch = 'main';

  private getToken(): string {
    return env.getStringOrThrow('GH_MEMECARDS_TOKEN');
  }

  private getFileExtensionFromUrl(url: string): string {
    const urlPath = new URL(url).pathname;
    const lastDot = urlPath.lastIndexOf('.');
    if (lastDot === -1) {
      return 'jpg';
    }
    return urlPath.substring(lastDot + 1).toLowerCase();
  }

  private async mergeImagesIntoPdf(
    images: { fileName: string; content: Buffer }[]
  ): Promise<Buffer> {
    const doc = await PDFDocument.create();
    for (const img of images) {
      const ext = img.fileName.replace(/^.*\./, '').toLowerCase();
      const isPng = ext === 'png';
      const bytes = new Uint8Array(img.content);
      const embed = isPng
        ? await doc.embedPng(bytes)
        : await doc.embedJpg(bytes);
      const width = embed.width;
      const height = embed.height;
      const page = doc.addPage([width, height]);
      page.drawImage(embed, { x: 0, y: 0, width, height });
    }
    const bytes = await doc.save();
    return Buffer.from(bytes);
  }

  private buildPhaseCsvFiles(
    phaseData: PhaseDistributionData[]
  ): PhaseCsvFiles[] {
    const phaseMap = new Map<
      string,
      { airdrops: Map<string, number>; allowlists: Map<string, number> }
    >();

    for (const row of phaseData) {
      let phase = phaseMap.get(row.phase);
      if (!phase) {
        phase = { airdrops: new Map(), allowlists: new Map() };
        phaseMap.set(row.phase, phase);
      }

      if (row.count_airdrop > 0) {
        const current = phase.airdrops.get(row.wallet) || 0;
        phase.airdrops.set(row.wallet, current + row.count_airdrop);
      }
      if (row.count_allowlist > 0) {
        const current = phase.allowlists.get(row.wallet) || 0;
        phase.allowlists.set(row.wallet, current + row.count_allowlist);
      }
    }

    const sortedPhases = Array.from(phaseMap.keys()).sort((a, b) =>
      a.localeCompare(b)
    );
    const result: PhaseCsvFiles[] = [];

    for (let i = 0; i < sortedPhases.length; i++) {
      const phaseName = sortedPhases[i];
      const phase = phaseMap.get(phaseName)!;

      const airdropLines: string[] = [];
      const sortedAirdrops = Array.from(phase.airdrops.entries()).sort((a, b) =>
        a[0].localeCompare(b[0])
      );
      for (const [wallet, count] of sortedAirdrops) {
        airdropLines.push(`${wallet},${count}`);
      }

      const allowlistLines: string[] = [];
      const sortedAllowlists = Array.from(phase.allowlists.entries()).sort(
        (a, b) => a[0].localeCompare(b[0])
      );
      for (const [wallet, count] of sortedAllowlists) {
        allowlistLines.push(`${wallet},${count}`);
      }

      result.push({
        phaseIndex: i,
        phaseName,
        airdropsCsv: airdropLines.join('\n'),
        allowlistsCsv: allowlistLines.join('\n')
      });
    }

    return result;
  }

  async uploadDistributionForCard(
    contract: string,
    cardId: number
  ): Promise<{
    success: boolean;
    message: string;
    github_folder: string;
    deleted_files: string[];
    uploaded_files: string[];
  }> {
    const overview = await fetchDistributionOverview(contract, cardId);
    if (!overview.is_normalized) {
      throw new BadRequestException(
        `Cannot upload to GitHub: Distribution for ${contract}#${cardId} is not normalized. Please call /normalize first.`
      );
    }

    const photos = await fetchDistributionPhotos(contract, cardId);
    if (photos.length === 0) {
      throw new BadRequestException(
        `Cannot upload to GitHub: No photos found for ${contract}#${cardId}. Please upload photos first.`
      );
    }

    const airdrops = await fetchDistributionAirdrops(contract, cardId);
    if (airdrops.length === 0) {
      throw new BadRequestException(
        `Cannot upload to GitHub: No automatic airdrops found for ${contract}#${cardId}. Please upload airdrops first.`
      );
    }

    const phaseData = await fetchDistributionsByPhase(contract, cardId);

    this.logger.info(
      `GitHub upload for ${contract}#${cardId}: ${photos.length} photos, ${airdrops.length} airdrop entries, ${phaseData.length} phase distribution rows`
    );

    const photoBuffers: { fileName: string; content: Buffer }[] = [];
    for (let i = 0; i < photos.length; i++) {
      const photoUrl = photos[i].link;
      const extension = this.getFileExtensionFromUrl(photoUrl);
      const fileName = `card${cardId}_${i + 1}.${extension}`;

      this.logger.info(`Fetching photo ${i + 1}/${photos.length}: ${photoUrl}`);
      const photoResp = await fetch(photoUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; 6529DistributionBot/1.0; +https://6529.io)',
          Accept: 'image/*,*/*;q=0.8'
        }
      });
      if (!photoResp.ok) {
        throw new BadRequestException(
          `Failed to fetch photo from ${photoUrl}: ${photoResp.status} ${photoResp.statusText}`
        );
      }
      const buffer = Buffer.from(await photoResp.arrayBuffer());
      photoBuffers.push({ fileName, content: buffer });
    }

    const pdfBuffer = await this.mergeImagesIntoPdf(photoBuffers);
    const photoFilesForUpload = [
      { fileName: `Meme_Card_${cardId}.pdf`, content: pdfBuffer }
    ];

    const airdropLines: string[] = [];
    for (const airdrop of airdrops) {
      airdropLines.push(`${airdrop.wallet},${airdrop.count}`);
    }
    const airdropFinalCsv = airdropLines.join('\n');

    const phaseCsvFiles = this.buildPhaseCsvFiles(phaseData);

    this.logger.info(
      `Uploading to GitHub for card${cardId} (will replace existing folder)...`
    );
    const { uploadedFiles, deletedFiles } = await this.uploadDistributionFiles(
      cardId,
      photoFilesForUpload,
      airdropFinalCsv,
      phaseCsvFiles
    );

    this.logger.info(
      `GitHub upload complete for ${contract}#${cardId}. Deleted ${deletedFiles.length} files, uploaded ${uploadedFiles.length} files.`
    );

    return {
      success: true,
      message: 'Distribution uploaded to GitHub',
      github_folder: `card${cardId}`,
      deleted_files: deletedFiles,
      uploaded_files: uploadedFiles
    };
  }

  private getCommitterInfo() {
    const name =
      env.getStringOrNull('GH_MEMECARDS_COMMITTER_NAME') ??
      '6529 Distribution Bot';
    const email =
      env.getStringOrNull('GH_MEMECARDS_COMMITTER_EMAIL') ??
      'distribution@6529.io';
    const date = new Date().toISOString();
    return { name, email, date };
  }

  private api(path: string, options: NodeFetchRequestInit = {}) {
    const token = this.getToken();
    const rawHeaders = options.headers;
    const extraHeaders =
      rawHeaders &&
      typeof rawHeaders === 'object' &&
      !Array.isArray(rawHeaders) &&
      typeof (rawHeaders as { get?: unknown }).get !== 'function'
        ? (rawHeaders as Record<string, string>)
        : {};
    const init: NodeFetchRequestInit = {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...extraHeaders
      }
    };
    return fetch(`${API_BASE}/${this.owner}/${this.repo}${path}`, init);
  }

  async uploadDistributionFiles(
    cardId: number,
    photos: PhotoUpload[],
    airdropFinalCsv: string,
    phaseCsvFiles: PhaseCsvFiles[]
  ): Promise<{ uploadedFiles: string[]; deletedFiles: string[] }> {
    const folderPath = `card${cardId}`;
    const existingFiles = await this.listFolderContents(folderPath);
    const deletedFiles = existingFiles
      .filter((f) => f.type === 'file')
      .map((f) => f.path);

    const treeEntries: { path: string; content: Buffer }[] = [];
    for (const photo of photos) {
      treeEntries.push({
        path: photo.fileName,
        content: photo.content
      });
    }
    treeEntries.push({
      path: 'airdrop_final.csv',
      content: Buffer.from(airdropFinalCsv)
    });
    for (const phaseCsv of phaseCsvFiles) {
      if (phaseCsv.airdropsCsv.length > 0) {
        treeEntries.push({
          path: `phase_${phaseCsv.phaseIndex}_airdrops.csv`,
          content: Buffer.from(phaseCsv.airdropsCsv)
        });
      }
      if (phaseCsv.allowlistsCsv.length > 0) {
        treeEntries.push({
          path: `phase_${phaseCsv.phaseIndex}_allowlists.csv`,
          content: Buffer.from(phaseCsv.allowlistsCsv)
        });
      }
    }

    const committer = this.getCommitterInfo();
    const refResp = await this.api(`/git/refs/heads/${this.branch}`);
    if (!refResp.ok) {
      throw new Error(
        `Failed to get ref: ${refResp.status} - ${await refResp.text()}`
      );
    }
    const refData = (await refResp.json()) as { object: { sha: string } };
    const commitSha = refData.object.sha;

    const commitResp = await this.api(`/git/commits/${commitSha}`);
    if (!commitResp.ok) {
      throw new Error(
        `Failed to get commit: ${commitResp.status} - ${await commitResp.text()}`
      );
    }
    const commitData = (await commitResp.json()) as { tree: { sha: string } };
    const rootTreeSha = commitData.tree.sha;

    const blobShas: { path: string; sha: string }[] = [];
    for (const entry of treeEntries) {
      const blobResp = await this.api('/git/blobs', {
        method: 'POST',
        body: JSON.stringify({
          content: entry.content.toString('base64'),
          encoding: 'base64'
        })
      });
      if (!blobResp.ok) {
        throw new Error(
          `Failed to create blob ${entry.path}: ${blobResp.status} - ${await blobResp.text()}`
        );
      }
      const blobData = (await blobResp.json()) as { sha: string };
      blobShas.push({ path: entry.path, sha: blobData.sha });
    }

    const cardTreeBody = {
      tree: blobShas.map(({ path, sha }) => ({
        path,
        mode: '100644',
        type: 'blob' as const,
        sha
      }))
    };
    const cardTreeResp = await this.api('/git/trees', {
      method: 'POST',
      body: JSON.stringify(cardTreeBody)
    });
    if (!cardTreeResp.ok) {
      throw new Error(
        `Failed to create tree for ${folderPath}: ${cardTreeResp.status} - ${await cardTreeResp.text()}`
      );
    }
    const cardTreeData = (await cardTreeResp.json()) as { sha: string };
    const cardTreeSha = cardTreeData.sha;

    const rootTreeBody = {
      base_tree: rootTreeSha,
      tree: [
        {
          path: folderPath,
          mode: '040000',
          type: 'tree' as const,
          sha: cardTreeSha
        }
      ]
    };
    const rootTreeResp = await this.api('/git/trees', {
      method: 'POST',
      body: JSON.stringify(rootTreeBody)
    });
    if (!rootTreeResp.ok) {
      throw new Error(
        `Failed to create root tree: ${rootTreeResp.status} - ${await rootTreeResp.text()}`
      );
    }
    const newRootTreeData = (await rootTreeResp.json()) as { sha: string };

    const commitMessage = `Card ${cardId} Distribution`;
    const newCommitBody = {
      message: commitMessage,
      tree: newRootTreeData.sha,
      parents: [commitSha],
      author: committer,
      committer
    };
    const newCommitResp = await this.api('/git/commits', {
      method: 'POST',
      body: JSON.stringify(newCommitBody)
    });
    if (!newCommitResp.ok) {
      throw new Error(
        `Failed to create commit: ${newCommitResp.status} - ${await newCommitResp.text()}`
      );
    }
    const newCommitData = (await newCommitResp.json()) as { sha: string };

    const updateRefResp = await this.api(`/git/refs/heads/${this.branch}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommitData.sha })
    });
    if (!updateRefResp.ok) {
      throw new Error(
        `Failed to update ref: ${updateRefResp.status} - ${await updateRefResp.text()}`
      );
    }

    const uploadedFiles = treeEntries.map((e) => `${folderPath}/${e.path}`);
    this.logger.info(
      `Single commit for card ${cardId}: ${uploadedFiles.length} files`
    );
    return { uploadedFiles, deletedFiles };
  }

  private async listFolderContents(
    folderPath: string
  ): Promise<GitHubFileInfo[]> {
    const contentResp = await this.api(
      `/contents/${folderPath}?ref=${this.branch}`
    );

    if (contentResp.status === 404) {
      this.logger.info(`Folder ${folderPath} does not exist yet`);
      return [];
    }

    if (!contentResp.ok) {
      const errorText = await contentResp.text();
      throw new Error(
        `Failed to list folder ${folderPath}: ${contentResp.status} - ${errorText}`
      );
    }

    const contents = (await contentResp.json()) as GitHubFileInfo[];
    return contents;
  }
}

export const githubDistributionService = new GitHubDistributionService();
