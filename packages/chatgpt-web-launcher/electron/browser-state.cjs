"use strict";

const NAVIGATION_ACTIONS = Object.freeze(new Set(["back", "forward", "reload"]));

function browserViewVisible(requestedVisible, surfaceActive, boundsReady = true) {
  return requestedVisible === true && surfaceActive === true && boundsReady === true;
}

function constrainBrowserBounds(bounds, contentSize) {
  if (!bounds || typeof bounds !== "object") throw new TypeError("browser_bounds_invalid");
  const contentWidth = Math.max(1, Math.round(Number(contentSize?.width) || 0));
  const contentHeight = Math.max(1, Math.round(Number(contentSize?.height) || 0));
  const x = Math.min(contentWidth - 1, Math.max(0, Math.round(Number(bounds.x) || 0)));
  const y = Math.min(contentHeight - 1, Math.max(0, Math.round(Number(bounds.y) || 0)));
  return Object.freeze({
    x,
    y,
    width: Math.min(contentWidth - x, Math.max(1, Math.round(Number(bounds.width) || 0))),
    height: Math.min(contentHeight - y, Math.max(1, Math.round(Number(bounds.height) || 0))),
  });
}

function readBrowserNavigationState(contents, fallback = {}) {
  if (!contents || contents.isDestroyed()) {
    return Object.freeze({
      loading: fallback.loading === true,
      canGoBack: fallback.canGoBack === true,
      canGoForward: fallback.canGoForward === true,
    });
  }
  const history = contents.navigationHistory;
  return Object.freeze({
    loading: contents.isLoading() === true,
    canGoBack: history.canGoBack() === true,
    canGoForward: history.canGoForward() === true,
  });
}

function navigateBrowser(contents, action) {
  if (!NAVIGATION_ACTIONS.has(action)) throw new Error("browser_navigation_action_not_allowed");
  const history = contents.navigationHistory;
  if (action === "back" && history.canGoBack()) history.goBack();
  if (action === "forward" && history.canGoForward()) history.goForward();
  if (action === "reload") contents.reload();
}

module.exports = {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
};
