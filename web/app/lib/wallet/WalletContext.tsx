"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { WalletPickerModal, type WalletOption } from "@sylox/ui/components";
import { getKit } from "./kit";

export interface SignResult {
  signedTxXdr: string;
  signerAddress?: string;
}

interface WalletContextValue {
  address: string | null;
  isModalOpen: boolean;
  isConnecting: boolean;
  error: string | null;
  openPicker: () => void;
  closePicker: () => void;
  disconnect: () => void;
  /** Signs an XDR string with the connected wallet. Throws (plain-language message) if no wallet is connected. */
  signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<SignResult>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

function plainLanguageError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    // The kit's own IKitError shape, or a thrown Error - either way,
    // its message is already meant to be read, not a stack trace.
    return error.message;
  }
  return "Something went wrong connecting the wallet. Try again.";
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallets, setWallets] = useState<WalletOption[]>([]);

  const openPicker = useCallback(() => {
    setError(null);
    setIsModalOpen(true);
    // Fire-and-forget: populates the list once the kit (lazy-loaded
    // here, not before) resolves. The modal shows its own empty state
    // until this lands, rather than blocking the open on it.
    (async () => {
      try {
        const kit = await getKit();
        const supported = await kit.refreshSupportedWallets();
        setWallets(
          supported.map((w) => ({
            id: w.id,
            name: w.name,
            icon: w.icon,
            installed: w.isAvailable,
            installUrl: w.url,
          })),
        );
      } catch (e) {
        setError(plainLanguageError(e));
      }
    })();
  }, []);

  const closePicker = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const handleSelectWallet = useCallback(async (id: string) => {
    setIsConnecting(true);
    setError(null);
    try {
      const kit = await getKit();
      kit.setWallet(id);
      const { address: connected } = await kit.fetchAddress();
      setAddress(connected);
      setIsModalOpen(false);
    } catch (e) {
      setError(plainLanguageError(e));
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    (async () => {
      try {
        const kit = await getKit();
        await kit.disconnect();
      } catch {
        // Disconnect is best-effort client-side state; a failure here
        // (e.g. the kit was never actually loaded this session) has
        // nothing left to clean up.
      }
    })();
  }, []);

  const signTransaction = useCallback(
    async (xdr: string, opts?: { networkPassphrase?: string }): Promise<SignResult> => {
      if (!address) {
        throw new Error("No wallet connected. Connect a wallet, then try again.");
      }
      const kit = await getKit();
      // Only the XDR string and the returned XDR string cross this
      // boundary - the kit's own SDK (17.x) never hands this app a
      // Transaction or any other SDK object to hold onto (see kit.ts).
      const result = await kit.signTransaction(xdr, { ...opts, address });
      return result;
    },
    [address],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      address,
      isModalOpen,
      isConnecting,
      error,
      openPicker,
      closePicker,
      disconnect,
      signTransaction,
    }),
    [address, isModalOpen, isConnecting, error, openPicker, closePicker, disconnect, signTransaction],
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      <WalletPickerModal
        isOpen={isModalOpen}
        onClose={closePicker}
        wallets={wallets}
        onSelectWallet={handleSelectWallet}
        isConnecting={isConnecting}
        error={error}
      />
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside a WalletProvider");
  return ctx;
}
