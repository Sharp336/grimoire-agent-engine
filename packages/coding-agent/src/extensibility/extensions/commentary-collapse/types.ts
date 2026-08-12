export type NativePhase = "commentary" | "final_answer";

export interface TextSignatureV1 {
	readonly v: 1;
	readonly id: string;
	readonly phase?: NativePhase;
}

export interface PhaseTextBlock {
	readonly type: "text";
	readonly text: string;
	readonly textSignature?: string;
}

export interface PhaseMessage {
	readonly content?: readonly unknown[];
}

export interface MessagePhaseInspection {
	readonly hasCommentary: boolean;
	readonly hasFinalAnswer: boolean;
	readonly phaseAware: boolean;
}
