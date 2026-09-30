import { mountParticipantsDialog } from "../../../client/src/participantsDialog";

function makeDialog() {
  const dialog = {
    isConnected: true,
    open: false,
    showModal: jest.fn(() => {
      if (!dialog.isConnected || dialog.open) throw new Error("InvalidStateError");
      dialog.open = true;
    }),
    close: jest.fn(() => { dialog.open = false; }),
  };
  return dialog;
}

describe("Participants native dialog lifetime", () => {
  it("opens on attachment, closes before removal and restores focus without scrolling", () => {
    const dialog = makeDialog();
    const opener = { isConnected: true, focus: jest.fn() };
    const detach = mountParticipantsDialog(dialog, opener);
    expect(dialog.open).toBe(true);
    detach();
    expect(dialog.open).toBe(false);
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("supports StrictMode setup/cleanup/setup and repeated cleanup", () => {
    const dialog = makeDialog();
    mountParticipantsDialog(dialog, null)();
    const detach = mountParticipantsDialog(dialog, null);
    expect(dialog.open).toBe(true);
    detach();
    detach();
    expect(dialog.showModal).toHaveBeenCalledTimes(2);
    expect(dialog.close).toHaveBeenCalledTimes(2);
  });

  it("opens a replacement node even when the visibility state stays true", () => {
    const oldDialog = makeDialog();
    const newDialog = makeDialog();
    const detach = mountParticipantsDialog(oldDialog, null);
    detach();
    oldDialog.isConnected = false;
    mountParticipantsDialog(newDialog, null);
    expect(oldDialog.open).toBe(false);
    expect(newDialog.open).toBe(true);
  });

  it("does not show an already-open or disconnected dialog", () => {
    const dialog = makeDialog();
    dialog.open = true;
    mountParticipantsDialog(dialog, null)();
    expect(dialog.showModal).not.toHaveBeenCalled();
    dialog.isConnected = false;
    mountParticipantsDialog(dialog, null)();
    expect(dialog.showModal).not.toHaveBeenCalled();
  });

  it("does not focus an opener removed by session end or navigation", () => {
    const dialog = makeDialog();
    const opener = { isConnected: true, focus: jest.fn() };
    const detach = mountParticipantsDialog(dialog, opener);
    opener.isConnected = false;
    detach();
    expect(dialog.open).toBe(false);
    expect(opener.focus).not.toHaveBeenCalled();
  });
});
