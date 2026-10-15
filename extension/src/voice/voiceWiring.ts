import { realScheduler, type ConnectionState, type Disposable, type Scheduler } from '../backend/backendClient';
import type { TranscriptStore } from '../transcript/transcriptStore';
import type { AudioChunk } from './audioRelay';
import { AudioRelay, type AudioClipSender } from './audioRelay';
import { BackendClipTranscriber, routeTranscriptions, type ClipClient } from './backendClipTranscriber';
import { BackendLocalVoiceInput, type RecorderClient } from './backendLocalVoiceInput';
import { VoiceController } from './voiceController';
import { DEFAULT_VOICE_KIND } from './voiceInput';
import { VoiceSession, type VoiceSessionView } from './voiceSession';
import { WebviewVoiceInput, type WebviewMicState } from './webviewVoiceInput';

/**
 * Builds and owns the whole voice stack for the extension (Task 8.13; Req 9.7, 18.1, 18.2, 18.5,
 * 18.6, 19.7). `extension.ts` constructs one of these when `kirosight.voice.enabled` is on; nothing
 * here knows about VS Code, so the wiring is unit-testable on fakes.
 *
 * It only connects existing parts and adds no voice logic of its own:
 *
 * - `BackendLocalVoiceInput` (the Spike D default, `DEFAULT_VOICE_KIND`) and `WebviewVoiceInput`
 *   (the fallback) are both provided to one `VoiceController`, which prefers the backend-local one.
 *   A webview that gives no audio is written off for the session by the controller, so a broken
 *   webview microphone is not retried again and again.
 * - `VoiceSession` is the only voice state machine. It decides what activation does, writes the
 *   Transcript entries and produces the voice part of the view model.
 * - Finished text goes to `InputPipeline.handle(text, 'voice')`, the same call typed text uses.
 *
 * Lifecycle: constructing it opens nothing, sends nothing and records nothing. The 10 s voice start
 * budget begins when the panel opens. The microphone opens only when the user presses push-to-talk
 * or invokes `kirosight.activate` while voice is known to be usable. Closing the panel, `Escape`, a
 * lost backend and `dispose()` all stop a recording and release the microphone.
 */

/** Said in the push-to-talk note and the Transcript when the setting turns voice off. */
export const VOICE_DISABLED_TEXT = 'Voice is turned off in the KiroSight settings. You can keep typing.';

/** The voice view when the setting is off. The status stays as the rest of the panel says. */
export const VOICE_DISABLED_VIEW: VoiceSessionView = Object.freeze({
  voice: Object.freeze({ state: 'unavailable' as const, reasonText: VOICE_DISABLED_TEXT }),
  listening: false,
  statusKind: null,
});

/** The slice of BackendClient the voice stack uses. BackendClient satisfies it structurally. */
export interface VoiceWiringClient extends RecorderClient, ClipClient, AudioClipSender {}

/** The slice of WebviewProvider the voice stack uses. */
export interface VoicePanelPort {
  readonly isOpen: boolean;
  sendCaptureCommand(type: 'start_capture' | 'stop_capture'): boolean;
  notifyBackendUnavailable(kind: 'text' | 'audio', message: string): void;
}

/** What the panel's validated microphone and push-to-talk messages are handed to. */
export interface VoiceHooks {
  onMicState(state: WebviewMicState): void;
  onAudioClip(chunk: AudioChunk): void;
  onPushToTalkToggle(): Promise<void>;
  onInterrupt(): void;
}

export interface VoiceWiringDeps {
  readonly client: VoiceWiringClient;
  readonly transcript: Pick<TranscriptStore, 'append'>;
  /** InputPipeline satisfies this. It is the only thing finished text is given to. */
  readonly pipeline: { handle(text: string, source: 'voice'): Promise<unknown> };
  readonly panel: VoicePanelPort;
  /** Told whenever the voice part of the view changed (status, Transcript entries, listening). */
  readonly onChange: (view: VoiceSessionView) => void;
  readonly scheduler?: Scheduler;
}

export class VoiceWiring implements Disposable {
  public readonly session: VoiceSession;
  public readonly controller: VoiceController;
  public readonly hooks: VoiceHooks;

  private readonly webviewInput: WebviewVoiceInput;
  private readonly localInput: BackendLocalVoiceInput;
  private readonly clips: BackendClipTranscriber;
  private readonly subscriptions: Disposable[] = [];
  private panelOpen = false;
  private disposed = false;

  /** Construction has no side effects: no frame is sent, no timer started and no microphone opened. */
  public constructor(private readonly deps: VoiceWiringDeps) {
    const scheduler = deps.scheduler ?? realScheduler;

    // Webview capture: the page records only when the host asks, and its audio is relayed to the
    // backend in order. A relay failure is told to the panel in plain text.
    const relay = new AudioRelay(deps.client, (message) => deps.panel.notifyBackendUnavailable('audio', message));
    this.webviewInput = new WebviewVoiceInput({
      bridge: {
        isOpen: () => deps.panel.isOpen,
        command: (type) => { deps.panel.sendCaptureCommand(type); },
      },
      relay,
      scheduler,
      onFirstSample: () => this.controller.notifyFirstSample(),
    });

    // Backend-local capture: the Spike D default. The backend records and transcribes.
    this.localInput = new BackendLocalVoiceInput({ client: deps.client, scheduler });
    this.clips = new BackendClipTranscriber(deps.client);

    this.controller = new VoiceController({
      inputs: { backend_local: this.localInput, webview: this.webviewInput },
      transcriber: routeTranscriptions(this.localInput, this.clips),
      pipeline: deps.pipeline,
      scheduler,
      preferred: DEFAULT_VOICE_KIND,
    });
    this.session = new VoiceSession({
      controller: this.controller,
      transcript: deps.transcript,
      getCapabilities: () => deps.client.capabilities,
      scheduler,
    });

    this.subscriptions.push(
      this.session.onChange((view) => deps.onChange(view)),
      this.localInput.onRecordingEnded((end) => this.session.notifyRecordingEnded(end)),
      deps.client.onStateChange((state) => this.onBackendState(state)),
    );

    this.hooks = {
      onMicState: (state) => { if (!this.disposed) this.webviewInput.handleMicState(state); },
      onAudioClip: (chunk) => { if (!this.disposed) this.webviewInput.handleAudioClip(chunk); },
      onPushToTalkToggle: () => this.session.togglePushToTalk(),
      onInterrupt: () => this.session.cancel(),
    };
  }

  /** The panel opened: the 10 s voice start budget begins. Still records nothing. */
  public panelOpened(): void {
    if (this.disposed) return;
    this.panelOpen = true;
    this.session.begin();
    if (this.deps.client.state === 'connected') void this.session.initialize();
  }

  /** The panel closed: stop any recording and release the microphone. Closing is not a failure to report. */
  public panelClosed(): void {
    if (this.disposed) return;
    this.panelOpen = false;
    this.session.cancel();
    this.webviewInput.cancel();
  }

  /** `kirosight.activate`: opens or focuses the panel first, always, then listens only if voice is usable. */
  public activate(openPanel: () => void): Promise<void> {
    return this.session.activate(openPanel);
  }

  /** Releases every listener, timer and the microphone. The stack is inert afterwards. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.session.dispose();
    this.controller.dispose();
    this.webviewInput.cancel();
    this.localInput.dispose();
    this.clips.dispose();
  }

  private onBackendState(state: ConnectionState): void {
    // While the panel is closed the connection is closed on purpose, which is not news.
    if (this.disposed || !this.panelOpen || state === 'connecting') return;
    void this.session.initialize();
  }
}
