/**
 * AISettingsPanel.tsx
 *
 * Modal de configuración del motor de IA.
 * Permite seleccionar provider, introducir API key y probar la conexión.
 */

import React, { useState, useEffect } from 'react';
import { Modal, Button, Select, Input } from './index';
import { getSettings, saveSettings } from '@/data/db';
import type { AISettings, AIProviderType } from '@/domain/models';
import { isHoardMode, useHoardMode } from '@/data/hoardMode';

interface AISettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

const OPENAI_MODELS = [
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini (barato, rápido)' },
  { value: 'gpt-4o', label: 'GPT-4o (mejor calidad)' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
];

const ANTHROPIC_MODELS = [
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 (recomendado)' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (más rápido)' },
  { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5 (mejor calidad)' },
];

const WEBLLM_MODELS = [
  { value: 'Llama-3.1-8B-Instruct-q4f16_1-MLC', label: 'Llama 3.1 8B (recomendado, ~4GB)' },
  { value: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi 3.5 Mini (más ligero, ~2GB)' },
  { value: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 7B (~4GB)' },
  { value: 'gemma-2-9b-it-q4f16_1-MLC', label: 'Gemma 2 9B (~5GB)' },
];

export function AISettingsPanel({ open, onClose, onSaved }: AISettingsPanelProps) {
  const hoard = useHoardMode();
  const [provider, setProvider] = useState<AIProviderType>(isHoardMode() ? 'hoard' : 'openai');
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o-mini');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState('claude-sonnet-4-5-20250929');
  const [webllmModel, setWebllmModel] = useState('Llama-3.1-8B-Instruct-q4f16_1-MLC');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Load existing settings
  useEffect(() => {
    if (!open) return;
    getSettings().then((s) => {
      const ai = s.aiSettings;
      if (!ai && isHoardMode()) setProvider('hoard');
      if (ai) {
        // 'hoard' guardado pero sin servidor local → vuelve a OpenAI
        setProvider(ai.provider === 'hoard' && !isHoardMode() ? 'openai' : ai.provider);
        if (ai.openaiApiKey) setOpenaiKey(ai.openaiApiKey);
        if (ai.openaiModel) setOpenaiModel(ai.openaiModel);
        if (ai.anthropicApiKey) setAnthropicKey(ai.anthropicApiKey);
        if (ai.anthropicModel) setAnthropicModel(ai.anthropicModel);
        if (ai.webllmModel) setWebllmModel(ai.webllmModel);
      }
    });
  }, [open]);

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (provider === 'hoard') {
        if (import.meta.env.VITE_HOARD === '1' && isHoardMode()) {
          const { getCapabilities } = await import('@/data/hoardClient');
          const caps = await getCapabilities(true);
          if (!caps.llm) throw new Error('Hypatia está conectado, pero no hay ningún modelo de texto disponible (revisa Hoard Link).');
          setTestResult({ ok: true, message: 'Modelo local disponible a través de Hypatia' });
        } else {
          throw new Error('Hypatia no está disponible.');
        }
      } else if (provider === 'openai') {
        if (!openaiKey.trim()) throw new Error('Introduce tu API key de OpenAI');
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${openaiKey.trim()}` },
        });
        if (!res.ok) throw new Error(`Error ${res.status}: API key inválida`);
        setTestResult({ ok: true, message: 'Conexión exitosa con OpenAI' });
      } else if (provider === 'anthropic') {
        if (!anthropicKey.trim()) throw new Error('Introduce tu API key de Anthropic');
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey.trim(),
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: anthropicModel,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Di "ok"' }],
          }),
        });
        if (!res.ok && res.status === 401) throw new Error('API key inválida');
        setTestResult({ ok: true, message: 'Conexión exitosa con Anthropic' });
      } else if (provider === 'webllm') {
        // Check WebGPU support
        if (!('gpu' in navigator)) {
          throw new Error(
            'Tu navegador no soporta WebGPU. Necesitas Chrome 121+ o Edge 121+.'
          );
        }
        setTestResult({
          ok: true,
          message: 'WebGPU disponible. El modelo se descargará la primera vez que lo uses (~2-5 GB según el modelo).',
        });
      }
    } catch (err) {
      setTestResult({ ok: false, message: String(err instanceof Error ? err.message : err) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const aiSettings: AISettings = {
        provider,
        openaiApiKey: openaiKey.trim() || undefined,
        openaiModel,
        anthropicApiKey: anthropicKey.trim() || undefined,
        anthropicModel,
        webllmModel,
      };
      await saveSettings({ aiSettings });
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const currentKey = provider === 'openai' ? openaiKey : provider === 'anthropic' ? anthropicKey : '';
  const keyless = provider === 'webllm' || provider === 'hoard';
  const canSave = keyless || currentKey.trim().length > 10;

  return (
    <Modal open={open} onClose={onClose} title="Configuración de IA" size="md">
      <div className="flex flex-col gap-5">
        {/* Provider selector */}
        <Select
          label="Proveedor de IA"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as AIProviderType);
            setTestResult(null);
          }}
        >
          <option value="openai">OpenAI (API de pago)</option>
          <option value="anthropic">Anthropic / Claude (API de pago)</option>
          <option value="webllm">WebLLM (gratuito, local en tu navegador)</option>
          {hoard && <option value="hoard">Hypatia (modelos locales del PC)</option>}
        </Select>

        {provider === 'hoard' && (
          <div className="bg-sage-500/10 border border-sage-500/30 rounded-lg px-4 py-3">
            <p className="text-sm text-sage-300 font-medium">Modelo local vía Hypatia</p>
            <p className="text-xs text-ink-400 mt-1">
              Usa los modelos configurados en Hypatia's Hoard (Hoard Link) en este PC.
              Sin API key y sin salir de tu equipo.
            </p>
          </div>
        )}

        {/* OpenAI settings */}
        {provider === 'openai' && (
          <>
            <div>
              <Input
                label="API Key de OpenAI"
                type="password"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
                placeholder="sk-..."
              />
              <p className="text-xs text-ink-500 mt-1">
                Tu key se guarda solo en tu navegador (IndexedDB). Nunca se envía a ningún servidor excepto OpenAI.
              </p>
            </div>
            <Select
              label="Modelo"
              value={openaiModel}
              onChange={(e) => setOpenaiModel(e.target.value)}
            >
              {OPENAI_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </>
        )}

        {/* Anthropic settings */}
        {provider === 'anthropic' && (
          <>
            <div>
              <Input
                label="API Key de Anthropic"
                type="password"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
                placeholder="sk-ant-..."
              />
              <p className="text-xs text-ink-500 mt-1">
                Tu key se guarda solo en tu navegador. Solo se envía a la API de Anthropic.
              </p>
            </div>
            <Select
              label="Modelo"
              value={anthropicModel}
              onChange={(e) => setAnthropicModel(e.target.value)}
            >
              {ANTHROPIC_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </>
        )}

        {/* WebLLM settings */}
        {provider === 'webllm' && (
          <>
            <div className="bg-sage-500/10 border border-sage-500/30 rounded-lg px-4 py-3">
              <p className="text-sm text-sage-300 font-medium">Modelo local gratuito</p>
              <p className="text-xs text-ink-400 mt-1">
                WebLLM ejecuta el modelo directamente en tu navegador usando WebGPU.
                No necesitas API key ni cuenta. La primera vez se descargará el modelo
                (2-5 GB según el modelo elegido). Requiere Chrome 121+ o Edge 121+.
              </p>
              <p className="text-xs text-amber-400 mt-2">
                Nota: Los modelos locales son más lentos y menos precisos que las APIs de pago.
                Para mejores resultados usa OpenAI o Anthropic.
              </p>
            </div>
            <Select
              label="Modelo"
              value={webllmModel}
              onChange={(e) => setWebllmModel(e.target.value)}
            >
              {WEBLLM_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </>
        )}

        {/* Test result */}
        {testResult && (
          <div
            className={`rounded-lg px-3 py-2 text-sm ${
              testResult.ok
                ? 'bg-sage-500/10 border border-sage-500/30 text-sage-400'
                : 'bg-rose-500/10 border border-rose-500/30 text-rose-400'
            }`}
          >
            {testResult.message}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 justify-end border-t border-ink-800 pt-4">
          <Button
            variant="ghost"
            onClick={handleTestConnection}
            loading={testing}
            disabled={!keyless && !currentKey.trim()}
          >
            Probar conexión
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={!canSave}>
            Guardar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
