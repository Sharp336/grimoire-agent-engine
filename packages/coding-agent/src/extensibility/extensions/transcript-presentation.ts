import { ChatTranscriptBuilder as HostChatTranscriptBuilder } from "../../modes/components/chat-transcript-builder";
import { EventController as HostEventController } from "../../modes/controllers/event-controller";
import { UiHelpers as HostUiHelpers } from "../../modes/utils/ui-helpers";

type PrototypeHandle<T, K extends keyof T> = {
	readonly prototype: Pick<T, K>;
};

/**
 * The exact host `ChatTranscriptBuilder` constructor function, exposed as a
 * narrow prototype handle for extension wrappers. Wrap only `rebuild`,
 * `append`, `setExpanded`, or `reset`; wrappers must call the original method
 * they replace. The host owns construction, dependencies, and lifecycle,
 * including disposal, so extensions must not construct or dispose instances.
 * The handle is the shared host prototype, not an instance: an instance may be
 * replaced when the host rebuilds a surface, while a detached old instance
 * reference can become stale.
 *
 * Although the runtime value is necessarily a constructible JavaScript class
 * function so its identity stays exact, its TypeScript surface intentionally
 * has no call or `new` signature and exposes only the supported prototype
 * methods above.
 */
export const ChatTranscriptBuilder: PrototypeHandle<
	HostChatTranscriptBuilder,
	"rebuild" | "append" | "setExpanded" | "reset"
> = HostChatTranscriptBuilder;

/**
 * The exact host `EventController` constructor function, exposed as a narrow
 * prototype handle for extension wrappers. Wrap only
 * `resetTranscriptAnchors` or `handleEvent`; wrappers must call the original
 * method they replace. The host owns construction, event subscription, and
 * lifecycle/disposal, so extensions must not construct or dispose instances.
 * The handle is the shared host prototype, not an instance: the host may
 * replace a controller when changing the active surface, and detached old
 * instance references can become stale.
 *
 * Although the runtime value is necessarily a constructible JavaScript class
 * function so its identity stays exact, its TypeScript surface intentionally
 * has no call or `new` signature and exposes only the supported prototype
 * methods above.
 */
export const EventController: PrototypeHandle<HostEventController, "resetTranscriptAnchors" | "handleEvent"> =
	HostEventController;

/**
 * The exact host `UiHelpers` constructor function, exposed as a narrow
 * prototype handle for extension wrappers. Wrap only `addMessageToChat`,
 * `renderSessionContext`, or `renderInitialMessages`; wrappers must call the
 * original method they replace. The host owns construction, its interactive
 * context, and lifecycle; extensions must not construct or attempt to dispose
 * instances. The handle is the shared host prototype, not an instance: the
 * host may replace helpers when changing the active surface, and detached old
 * instance references can become stale.
 *
 * Although the runtime value is necessarily a constructible JavaScript class
 * function so its identity stays exact, its TypeScript surface intentionally
 * has no call or `new` signature and exposes only the supported prototype
 * methods above.
 */
export const UiHelpers: PrototypeHandle<
	HostUiHelpers,
	"addMessageToChat" | "renderSessionContext" | "renderInitialMessages"
> = HostUiHelpers;
