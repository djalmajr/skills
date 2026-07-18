// Demo inspired by https://ui.shadcn.com/examples/music
// Showcases: album cards, playlists sidebar, tabs (visual), tooltip.

import { html } from "htm/preact";
import { Button } from "htm-ui/button.js";
import { Icon } from "htm-ui/icon.js";
import { Separator } from "htm-ui/separator.js";
import { TabsList, TabsTrigger } from "htm-ui/tabs.js";
import { Tooltip } from "htm-ui/tooltip.js";

const ALBUMS = [
  { title: "React Rendezvous", artist: "Ethan Byte", color: "from-red-500 to-orange-500" },
  { title: "Async Awakenings", artist: "Nina Netcode", color: "from-purple-500 to-pink-500" },
  { title: "The Art of Reusability", artist: "Lena Logic", color: "from-blue-500 to-cyan-500" },
  { title: "Stateful Symphony", artist: "Beth Binary", color: "from-emerald-500 to-teal-500" },
  { title: "Thinking Components", artist: "Lena Logic", color: "from-amber-500 to-yellow-500" },
  { title: "Functional Fury", artist: "Beth Binary", color: "from-fuchsia-500 to-rose-500" },
];

function AlbumCard({ album }) {
  return html`
    <div class="space-y-3">
      <${Tooltip} content="Play preview" side="top">
        <div
          class=${`relative aspect-square w-full rounded-md overflow-hidden bg-gradient-to-br ${album.color} shadow-md cursor-pointer group`}
        >
          <div class="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
            <${Icon} icon="lucide:play" size=${32} className="text-white opacity-0 group-hover:opacity-100" />
          </div>
        </div>
      <//>
      <div>
        <p class="text-sm font-medium leading-none truncate">${album.title}</p>
        <p class="text-xs text-muted-foreground mt-1 truncate">${album.artist}</p>
      </div>
    </div>
  `;
}

function PlaylistsSidebar() {
  const playlists = [
    "Recently Added", "Recently Played", "Top Songs", "Top Albums",
    "Top Artists", "Logic Discography", "Bedtime Beats", "Feeling Happy",
    "I miss Y2K Pop", "Runtober", "Mellow Days", "Eternal Sunshine",
  ];
  return html`
    <aside class="w-[200px] shrink-0 border-r p-4 space-y-4 overflow-y-auto scrollbar-hidden">
      <div>
        <h3 class="text-xs font-semibold uppercase text-muted-foreground tracking-wide px-2 mb-2">Discover</h3>
        <nav class="space-y-1 text-sm">
          <a class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent">
            <${Icon} icon="lucide:list-music" />Listen Now
          </a>
          <a class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent bg-accent">
            <${Icon} icon="lucide:layout-grid" />Browse
          </a>
          <a class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent">
            <${Icon} icon="lucide:radio" />Radio
          </a>
        </nav>
      </div>
      <${Separator} />
      <div>
        <h3 class="text-xs font-semibold uppercase text-muted-foreground tracking-wide px-2 mb-2">Library</h3>
        <nav class="space-y-1 text-sm">
          <a class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent">
            <${Icon} icon="lucide:library" />Playlists
          </a>
          <a class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent">
            <${Icon} icon="lucide:music" />Songs
          </a>
          <a class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent">
            <${Icon} icon="lucide:user" />Artists
          </a>
        </nav>
      </div>
      <${Separator} />
      <div>
        <h3 class="text-xs font-semibold uppercase text-muted-foreground tracking-wide px-2 mb-2">Playlists</h3>
        <nav class="space-y-0.5 text-sm">
          ${playlists.map(
            (name) => html`
              <a key=${name} class="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground">
                <${Icon} icon="lucide:list-music" size=${14} />${name}
              </a>
            `,
          )}
        </nav>
      </div>
    </aside>
  `;
}

export function MusicPage() {
  return html`
    <div class="flex flex-1 w-full h-full overflow-hidden">
      <${PlaylistsSidebar} />

      <div class="flex-1 overflow-y-auto p-6 space-y-6">
        <div class="flex items-center justify-between">
          <${TabsList}>
            <${TabsTrigger} active=${true}>Music<//>
            <${TabsTrigger}>Podcasts<//>
            <${TabsTrigger}>Live<//>
          <//>
          <${Button} size="sm">
            <${Icon} icon="lucide:plus-circle" size=${14} />
            Add music
          <//>
        </div>

        <div>
          <h2 class="text-2xl font-bold tracking-tight">Listen Now</h2>
          <p class="text-muted-foreground text-sm mt-1">Top picks for you. Updated daily.</p>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
          ${ALBUMS.map((album) => html`<${AlbumCard} key=${album.title} album=${album} />`)}
        </div>

        <${Separator} />

        <div>
          <h2 class="text-xl font-semibold tracking-tight">Made for You</h2>
          <p class="text-muted-foreground text-sm mt-1">Your personal playlists. Updated daily.</p>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          ${ALBUMS.slice(0, 4).map((album) => html`<${AlbumCard} key=${album.title} album=${album} />`)}
        </div>
      </div>
    </div>
  `;
}
