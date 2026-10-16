import * as vscode from 'vscode';

import type { SubmitAckStatus } from '../pipeline/inputPipeline';
import {
  validateHostToWebviewMessage,
  validateWebviewToHostMessage,
  type HostToWebviewMessage,
  type WebviewToHostMessage,
} from '../protocol/bridgeMessages';
import type { TranscriptSource, TranscriptStore } from '../transcript/transcriptStore';
import type { AudioChunk } from '../voice/audioRelay';
import { buildWebviewHtml, generateNonce } from './html';
import { DEFAULT_VOICE, type ViewModel } from './viewModel';

export const WEBVIEW_VIEW_TYPE = 'kirosight.panel';
export const WEBVIEW_TITLE = 'KiroSight';

/** The slice of InputPipeline the provider uses; InputPipeline satisfies it. */
export interface PipelinePort {
  handle(text: string, source: TranscriptSource): Promise<SubmitAckStatus>;
  confirm(): Promise<void>;
  decline(): Promise<void>;
  interrupt(): void;
}

export interface WebviewProviderDeps {
  readonly extensionUri: vscode.Uri;
  readonly pipeline: PipelinePort;
  readonly transcript: Pick<TranscriptStore, 'append'>;
  /** The canonical current view model; the provider keeps no model of its own. */
  readonly getViewModel: () => ViewModel;
  /**
   * Called with true when the panel is created and with false when it is disposed. Repeated
   * openOrFocus() calls on an existing panel do not call it again.
   */
  readonly onPanelOpenChange?: (open: boolean) => void;
  /**
   * Receives the validated microphone messages from the panel (WebviewVoiceInput satisfies this).
   * Optional: without it those messages are dropped, as before voice existed.
   */
  readonly voice?: {
    onMicState(state: 'granted' | 'denied' | 'unavailable' | 'prompt'): void;
    onAudioClip(chunk: AudioChunk): void;
    /** The push-to-talk control was activated (Enter, Space or a click). Starts or ends listening. */
    onPushToTalkToggle?(): void | Promise<void>;
    /** Escape: abandon any recording or pending transcription. */
    onInterrupt?(): void;
  };
  /**
   * The one-time system notice recorded when the panel first opens. Left out, it is the original
   * "voice is unavailable until voice support is implemented" text. `null` records no notice (voice
   * is running and reports its own state); a string records that text (for example, voice is off).
   */
  readonly voiceNotice?: string | null;
}

type SubmitTextMessage = Extract<WebviewToHostMessage, { type: 'submit_text' }>;

/** The ViewModel as a view_state message: same fields, with the readonly transcript copied. */
function viewStateMessage(model: ViewModel): HostToWebviewMessage {
  return { type: 'view_state', ...model, transcript: [...model.transcript] };
}

export class WebviewProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private voiceNoticeRecorded = false;

  public constructor(private readonly deps: WebviewProviderDeps) {}

  /**
   * Creates the panel on first use, otherwise reveals the existing one, moving
   * keyboard focus into it (preserveFocus = false).
   */
  public openOrFocus(): void {
    this.recordVoiceNoticeOnce();

    if (this.panel) {
      this.panel.reveal(undefined, false);
      // Explicit re-activation: ask the webview to focus the command input.
      this.post(this.panel.webview, { type: 'focus_input' });
      return;
    }

    this.panel = this.createPanel();
    this.notifyPanelOpenChange(true);
  }

  /** Sends the full current view model, only while a panel exists. */
  public updateViewModel(model: ViewModel): void {
    if (this.panel) {
      this.post(this.panel.webview, viewStateMessage(model));
    }
  }

  /**
   * Tells an open panel that text or audio could not be relayed to the backend. The draft is
   * never touched: the webview only shows the message, and the submit_ack decides about the input.
   */
  public notifyBackendUnavailable(kind: 'text' | 'audio', message: string): void {
    if (this.panel) {
      this.post(this.panel.webview, { type: 'backend_unavailable', kind, message });
    }
  }

  /** True while the panel exists. */
  public get isOpen(): boolean {
    return this.panel !== undefined;
  }

  /**
   * Asks an open panel to start or stop recording. Returns false when no panel is open. The panel
   * never records on its own: it acts only on these two messages.
   */
  public sendCaptureCommand(type: 'start_capture' | 'stop_capture'): boolean {
    if (!this.panel) {
      return false;
    }
    this.post(this.panel.webview, { type });
    return true;
  }

  /**
   * Hands one synthesized clip to an open panel as `play_audio` (Task 9.3). Returns false, having
   * sent nothing, when no panel is open, the message does not validate, or posting throws.
   *
   * `webview.postMessage` returns a Thenable that resolves to false when the webview did not
   * receive the message (for example it was disposed) and may reject. A true return here therefore
   * means only "handed over"; when delivery turns out to have failed, `onUndelivered` is called
   * once, as soon as that is known. The panel plays the clip only when it arrives; playing is
   * Task 9.4. The audio is never logged or stored here.
   */
  public sendPlayAudio(
    audio: { readonly id: string; readonly mimeType: string; readonly base64: string },
    onUndelivered?: () => void,
  ): boolean {
    if (!this.panel) {
      return false;
    }
    const message: HostToWebviewMessage = { type: 'play_audio', ...audio };
    if (!validateHostToWebviewMessage(message).ok) {
      return false;
    }

    let delivery: Promise<boolean>;
    try {
      delivery = Promise.resolve(this.panel.webview.postMessage(message));
    } catch {
      return false;
    }
    let reported = false;
    const undelivered = (): void => {
      if (reported) return;
      reported = true;
      try {
        onUndelivered?.();
      } catch {
        // A failure observer must never become an unhandled rejection.
      }
    };
    delivery.then(
      (delivered) => { if (delivered === false) undelivered(); },
      () => undelivered(),
    );
    return true;
  }

  public dispose(): void {
    this.panel?.dispose();
  }

  private notifyPanelOpenChange(open: boolean): void {
    try {
      this.deps.onPanelOpenChange?.(open);
    } catch {
      // A lifecycle observer must never break the panel.
    }
  }

  private recordVoiceNoticeOnce(): void {
    if (this.voiceNoticeRecorded) {
      return;
    }
    this.voiceNoticeRecorded = true;
    const notice = this.deps.voiceNotice === undefined ? (DEFAULT_VOICE.reasonText ?? '') : this.deps.voiceNotice;
    if (notice !== null && notice !== '') {
      this.deps.transcript.append('system', notice);
    }
  }

  private createPanel(): vscode.WebviewPanel {
    const mediaRoot = vscode.Uri.joinPath(this.deps.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      WEBVIEW_VIEW_TYPE,
      WEBVIEW_TITLE,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        enableCommandUris: false,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      },
    );
    const webview = panel.webview;

    const subscription = webview.onDidReceiveMessage((raw: unknown) => this.handleMessage(webview, raw));
    panel.onDidDispose(() => {
      subscription.dispose();
      this.panel = undefined;
      this.notifyPanelOpenChange(false);
    });

    webview.html = buildWebviewHtml({
      cspSource: webview.cspSource,
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'styles.css')).toString(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js')).toString(),
      nonce: generateNonce(),
    });

    return panel;
  }

  /** Every incoming value is validated first; invalid input is dropped without any effect. */
  private async handleMessage(webview: vscode.Webview, raw: unknown): Promise<void> {
    try {
      const result = validateWebviewToHostMessage(raw);
      if (!result.ok) {
        return;
      }

      const message = result.value;
      switch (message.type) {
        case 'ready':
          this.post(webview, viewStateMessage(this.deps.getViewModel()));
          return;
        case 'submit_text':
          await this.submit(webview, message);
          return;
        case 'confirm':
          await this.deps.pipeline.confirm();
          return;
        case 'decline':
          await this.deps.pipeline.decline();
          return;
        case 'interrupt':
          this.deps.pipeline.interrupt();
          this.deps.voice?.onInterrupt?.();
          return;
        case 'mic_state':
          // Handed to the voice layer, if one is connected. The host never relays this itself.
          this.deps.voice?.onMicState(message.state);
          return;
        case 'audio_clip':
          this.deps.voice?.onAudioClip(message);
          return;
        case 'ptt_toggle':
          // The voice layer decides what a press means; without one the press has no effect.
          await this.deps.voice?.onPushToTalkToggle?.();
          return;
        case 'playback':
          // Playback arrives in Milestone 9.
          return;
      }
    } catch {
      // Untrusted input must never throw out of the message callback.
    }
  }

  private async submit(webview: vscode.Webview, message: SubmitTextMessage): Promise<void> {
    let status: SubmitAckStatus;
    try {
      status = await this.deps.pipeline.handle(message.text, 'typed');
    } catch {
      // Never report handled for a failure; the draft is kept for resubmission.
      status = 'not_handled';
    }
    this.post(webview, { type: 'submit_ack', submitId: message.submitId, status });
  }

  private post(webview: vscode.Webview, message: HostToWebviewMessage): void {
    if (!validateHostToWebviewMessage(message).ok) {
      return;
    }
    Promise.resolve(webview.postMessage(message)).catch(() => undefined);
  }
}
