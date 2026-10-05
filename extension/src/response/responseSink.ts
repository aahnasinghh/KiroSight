import * as vscode from 'vscode';

export interface ResponseSink {
  send(text: string): void;
}

export class VscodeResponseSink implements ResponseSink {
  public constructor(private readonly outputChannel: vscode.OutputChannel) {}

  public send(text: string): void {
    this.outputChannel.appendLine(text);
    this.outputChannel.show(true);
    void vscode.window.showInformationMessage(text);
  }
}
