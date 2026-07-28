declare module 'adm-zip' {
  type Entry = {
    readonly entryName: string;
    readonly isDirectory: boolean;
    readonly header: {
      readonly size: number;
      readonly compressedSize: number;
    };
    getData(): Buffer;
  };

  export default class AdmZip {
    public constructor(contents?: Buffer);
    public addFile(name: string, contents: Buffer): void;
    public getEntries(): Entry[];
    public toBuffer(): Buffer;
  }
}
