/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

const settings = definePluginSettings({
  av1: {
    type: OptionType.BOOLEAN,
    default: false,
    description: "Enable AV1 (experimental)",
  },
  h265: {
    type: OptionType.BOOLEAN,
    default: true,
    description: "Enable H.265",
  },
  vp9: {
    type: OptionType.BOOLEAN,
    default: true,
    description: "Enable VP9",
  },

  h264: {
    type: OptionType.BOOLEAN,
    default: true,
    description: "Enable H.264",
  },
  vp8: {
    type: OptionType.BOOLEAN,
    default: true,
    description: "Enable VP8",
  },
  av1Priority: {
    type: OptionType.SLIDER,
    description: "(lower = higher priority)",
    markers: [1, 2, 3, 4, 5],
    default: 1,
  },
  h265Priority: {
    type: OptionType.SLIDER,
    description: "(lower = higher priority)",
    markers: [1, 2, 3, 4, 5],
    default: 2,
  },
  vp9Priority: {
    type: OptionType.SLIDER,
    description: "(lower = higher priority)",
    markers: [1, 2, 3, 4, 5],
    default: 3,
  },
  h264Priority: {
    type: OptionType.SLIDER,
    description: "(lower = higher priority)",
    markers: [1, 2, 3, 4, 5],
    default: 4,
  },
  vp8Priority: {
    type: OptionType.SLIDER,
    description: "(lower = higher priority)",
    markers: [1, 2, 3, 4, 5],
    default: 5,
  },
});

function buildCodecArray() {
  const codecMap = [
    {
      name: "AV1",
      enabled: settings.store.av1,
      priority: settings.store.av1Priority,
      key: "AV1",
    },
    {
      name: "H265",
      enabled: settings.store.h265,
      priority: settings.store.h265Priority,
      key: "H265",
    },
    {
      name: "VP9",
      enabled: settings.store.vp9,
      priority: settings.store.vp9Priority,
      key: "VP9",
    },
    {
      name: "H264",
      enabled: settings.store.h264,
      priority: settings.store.h264Priority,
      key: "H264",
    },
    {
      name: "VP8",
      enabled: settings.store.vp8,
      priority: settings.store.vp8Priority,
      key: "VP8",
    },
  ];

  return codecMap
    .filter((codec) => codec.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map((codec) => codec.key);
}

export default definePlugin({
  name: "WebScreenShareFixesDev",
  authors: [Devs.Kaitlyn],
  description: "Removes 2500kbps bitrate cap on chromium and vesktop clients.",
  enabledByDefault: true,
  settings,
  getCodecs(codecEnum) {
    const codecMap = [
      {
        name: "AV1",
        enabled: settings.store.av1,
        priority: settings.store.av1Priority,
        key: "AV1",
      },
      {
        name: "H265",
        enabled: settings.store.h265,
        priority: settings.store.h265Priority,
        key: "H265",
      },
      {
        name: "VP9",
        enabled: settings.store.vp9,
        priority: settings.store.vp9Priority,
        key: "VP9",
      },
      {
        name: "H264",
        enabled: settings.store.h264,
        priority: settings.store.h264Priority,
        key: "H264",
      },
      {
        name: "VP8",
        enabled: settings.store.vp8,
        priority: settings.store.vp8Priority,
        key: "VP8",
      },
    ];

    const filtered = codecMap.filter((codec) => codec.enabled);
    const sorted = filtered.sort((a, b) => a.priority - b.priority);
    const result = sorted.map((codec) => {
      const value = codec.key === "AV1" ? "AV1" : codecEnum[codec.key];
      return value;
    });
    return result;
  },
  patches: [
    {
      find: "x-google-max-bitrate",
      replacement: [
        {
          match: /"x-google-max-bitrate=".concat\(\i\)/,
          replace: '"x-google-max-bitrate=".concat("80_000")',
        },
        {
          match: ";level-asymmetry-allowed=1",
          replace: ";b=AS:800000;level-asymmetry-allowed=1",
        },
        {
          match: /;usedtx=".concat\((\i)\?"0":"1"\)/,
          replace: '$&.concat($1?";stereo=1;sprop-stereo=1":"")',
        },
        {
          match: /\i\?\[(\i\.\i)\.H265,\i\.\i\.H264,\i\.\i\.VP8,\i\.\i\.VP9\]/,
          replace: "true?$self.getCodecs($1)",
        },
      ],
    },
  ],
});
