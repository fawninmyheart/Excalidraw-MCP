import { newElementWith } from "@excalidraw/element";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportScene,
  restoreAppState,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { ElementUpdate } from "@excalidraw/element";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { LocalData } from "./data/LocalData";

/** Expose the official editor API only in this opt-in, loopback deployment. */
export const attachLocalAutomation = (
  api: ExcalidrawImperativeAPI,
  ownerWindow: Window,
) => {
  if (
    import.meta.env.VITE_APP_LOCAL_AUTOMATION !== "true" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(ownerWindow.location.hostname)
  ) {
    return;
  }

  const getScene = () =>
    JSON.parse(
      serializeAsJSON(
        api.getSceneElements(),
        api.getAppState(),
        api.getFiles(),
        "local",
      ),
    );

  const save = async () => {
    // React applies appState on the next render; timers also run in background tabs.
    await new Promise((resolve) => ownerWindow.setTimeout(resolve, 100));
    await LocalData.saveImmediately(
      api.getSceneElements(),
      api.getAppState(),
      api.getFiles(),
    );
    return getScene();
  };

  const bridge = {
    getScene,
    isReady: () =>
      !api.getAppState().isLoading &&
      api
        .getSceneElements()
        .every(
          (element) =>
            element.type !== "image" ||
            !element.fileId ||
            element.status === "error" ||
            api.getFiles()[element.fileId],
        ),
    async append(skeletons: Parameters<typeof convertToExcalidrawElements>[0]) {
      if (!Array.isArray(skeletons)) {
        throw new Error("append expects an array of element skeletons");
      }
      const elements = convertToExcalidrawElements(skeletons);
      api.updateScene({
        elements: [...api.getSceneElements(), ...elements],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return save();
    },
    async updateElements(
      updates: {
        id: string;
        expectedVersion: number;
        changes: Record<string, unknown>;
      }[],
    ) {
      if (!Array.isArray(updates) || !updates.length) {
        throw new Error("updateElements expects a nonempty array of updates");
      }
      const current = api.getSceneElements();
      const currentById = new Map(
        current.map((element) => [element.id, element]),
      );
      const changesById = new Map<string, ElementUpdate<ExcalidrawElement>>();
      const protectedFields = new Set([
        "id",
        "type",
        "version",
        "versionNonce",
        "created",
        "updated",
        "index",
        "__proto__",
        "constructor",
        "prototype",
      ]);
      // Validate the entire batch before applying any change. Other elements'
      // versions do not participate, so independent edits can proceed together.
      for (const update of updates) {
        const element = currentById.get(update.id);
        if (changesById.has(update.id)) {
          throw new Error(`Duplicate update for element ${update.id}`);
        }
        if (!element || element.version !== update.expectedVersion) {
          throw new Error(
            `Element conflict: ${update.id} changed or was removed. Read the scene again and merge only the intended changes.`,
          );
        }
        if (
          !update.changes ||
          typeof update.changes !== "object" ||
          Array.isArray(update.changes)
        ) {
          throw new Error("Each update must contain a changes object");
        }
        if (
          Object.keys(update.changes).some((key) => protectedFields.has(key))
        ) {
          throw new Error(
            "Element identity and version fields cannot be changed",
          );
        }
        const changes = { ...update.changes };
        if ("text" in changes) {
          if (element.type !== "text" || typeof changes.text !== "string") {
            throw new Error("text changes require a text element and a string");
          }
          changes.originalText ??= changes.text;
        }
        changesById.set(update.id, changes as ElementUpdate<ExcalidrawElement>);
      }
      const elements = restoreElements(
        current.map((element) => {
          const changes = changesById.get(element.id);
          return changes ? newElementWith(element, changes) : element;
        }),
        currentById,
        { repairBindings: true, refreshDimensions: true },
      );
      if (elements.length !== current.length) {
        throw new Error("Invalid element changes could not be restored");
      }
      api.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return save();
    },
    async replace(scene: ImportedDataState) {
      if (scene?.type !== "excalidraw" || !Array.isArray(scene.elements)) {
        throw new Error("replace expects an Excalidraw scene file");
      }
      const current = new Map(api.getSceneElements().map((el) => [el.id, el]));
      const elements = restoreElements(scene.elements, current, {
        repairBindings: true,
        refreshDimensions: true,
      }).map((element) =>
        newElementWith(element, {
          version:
            Math.max(element.version, current.get(element.id)?.version ?? 0) +
            1,
        }),
      );
      if (scene.files) {
        api.addFiles(Object.values(scene.files));
      }
      api.updateScene({
        elements,
        appState: restoreAppState(scene.appState, api.getAppState()),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      return save();
    },
    async exportSVG() {
      const svg = await exportScene({
        type: "svg",
        data: {
          elements: api.getSceneElements(),
          appState: api.getAppState(),
          files: api.getFiles(),
        },
        config: { environment: { document: ownerWindow.document } },
      });
      return svg.outerHTML;
    },
  };

  const localWindow = ownerWindow as Window & {
    excalidrawLocal?: typeof bridge;
  };
  localWindow.excalidrawLocal = bridge;
  return () => {
    if (localWindow.excalidrawLocal === bridge) {
      delete localWindow.excalidrawLocal;
    }
  };
};
