/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    scan,
    switchMap,
    take,
    merge
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

/** Constants */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const Birb = {
    WIDTH: 42,
    HEIGHT: 30,
} as const;

const Constants = {
    PIPE_WIDTH: 50,
    TICK_RATE_MS: 16,
    GRAVITY: 0.5,           // pixel per tick^2
    FLAP_VELOCITY: -5,      // pixel per tick (negative = upward)
    PIPE_SPEED: 3,          // pixel per tick (pipes move left)
} as const;

// User input

type Key = "Space";

// State processing
type PipeData = Readonly<{ time: number; gapY: number; gapH: number }>;
type LivePipe = Readonly<{ id: number; x: number; gapYpx: number; gapHpx: number }>;

function parseCsv(csv: string): readonly PipeData[] {
  const lines = csv.trim().split('\n').slice(1); // skip header
  return lines.map(line => {
    const [gapY, gapH, time] = line.split(',').map(Number);
    return { gapY, gapH, time };
  });
}


type State = Readonly<{
    gameStarted: boolean;
    gameEnd: boolean;
    gameTime: number;
    birdY: number;
    birdVy: number;
    lives: number;
    score: number;
    pipes: readonly LivePipe[];
    nextPipeIdx: number;
}>;

const initialState: State = {
    gameStarted: false,
    gameEnd: false,
    gameTime: 0,
    birdY: Viewport.CANVAS_HEIGHT / 2,
    birdVy: 0,
    lives: 3,
    score: 0,
    pipes: [],
    nextPipeIdx: 0,
};

/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
const tick = (s: State, sched: readonly PipeData[]): State => {
    if (s.gameEnd) return s;

    const t  = s.gameTime + 1;

    const ticksToSec = (ticks: number) => (ticks * Constants.TICK_RATE_MS) / 1000;
    let next = s.nextPipeIdx;
    const spawned: LivePipe[] = [...s.pipes];

    while (next < sched.length && sched[next].time <= ticksToSec(t)) {
        const p = sched[next];
        spawned.push({
        id: next,
        x: Viewport.CANVAS_WIDTH,
        gapYpx: p.gapY * Viewport.CANVAS_HEIGHT,
        gapHpx: p.gapH * Viewport.CANVAS_HEIGHT,
        });
        next++;
    }

    // move & cull
    const moved = spawned
        .map(p => ({ ...p, x: p.x - Constants.PIPE_SPEED }))
        .filter(p => p.x + Constants.PIPE_WIDTH >= 0);
        
    const vy = s.birdVy + Constants.GRAVITY;
    const y  = s.birdY + vy;

    const top = Birb.HEIGHT / 2;
    const bot = Viewport.CANVAS_HEIGHT - Birb.HEIGHT / 2;
    const yClamped = Math.max(top, Math.min(bot, y));

    return {
        ...s,
        gameTime: t,
        birdVy: vy,
        birdY: yClamped,
    };
};
// Rendering (side effects)

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

const render = (): ((s: State) => void) => {
    // Canvas elements
    const gameOver = document.querySelector("#gameOver") as SVGElement;
    const container = document.querySelector("#main") as HTMLElement;

    // Text fields
    const livesText = document.querySelector("#livesText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );
    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    return (s: State) => {
        // Add birb to the main grid canvas
        const birdImg = createSvgElement(svg.namespaceURI, "image", {
            href: "assets/birb.png",
            x: `${Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2}`,
            y: `${Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2}`,
            width: `${Birb.WIDTH}`,
            height: `${Birb.HEIGHT}`,
        });
        svg.appendChild(birdImg);

        const existingPipes = svg.querySelectorAll(".pipe");
        existingPipes.forEach(p => p.remove());
        s.pipes.forEach(pipe => {

        // Top pipe
        const pipeTop = createSvgElement(svg.namespaceURI, "rect", {
            class: "pipe",
            x: `${pipe.x}`,
            y: "0",
            width: `${Constants.PIPE_WIDTH}`,
            height: `${pipe.gapYpx - pipe.gapHpx / 2}`,
            fill: "green",
        });

        // Bottom pipe
        const pipeBottom = createSvgElement(svg.namespaceURI, "rect", {
            class: "pipe",
            x: `${pipe.x}`,
            y: `${pipe.gapYpx + pipe.gapHpx / 2}`,
            width: `${Constants.PIPE_WIDTH}`,
            height: `${Viewport.CANVAS_HEIGHT - (pipe.gapYpx + pipe.gapHpx / 2)}`,
            fill: "green",
        });

        svg.appendChild(pipeTop);
        svg.appendChild(pipeBottom);
        });
    };
};

export const state$ = (csvContents: string): Observable<State> => {
    /** User input */
    const sched = parseCsv(csvContents);

    const key$ = fromEvent<KeyboardEvent>(document, "keypress");
    const fromKey = (keyCode: Key) =>
        key$.pipe(filter(({ code }) => code === keyCode));

    const flap$ = fromKey("Space").pipe(
        map(() => (s: State) => ({
            ...s,
            gameStarted: true,
            birdVy: Constants.FLAP_VELOCITY
        }))
    );

    /** Determines the rate of time steps */
    const tick$ = interval(Constants.TICK_RATE_MS).pipe(
        map(() => (s: State) => tick(s, sched))
    );

    return merge(tick$, flap$).pipe(
        scan((s, f) => f(s), initialState)
    );
};

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map.csv`;

    // Get the file from URL
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            throw err;
        }),
    );

    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    csv$.pipe(
        switchMap(contents =>
            // On click - start the game
            click$.pipe(switchMap(() => state$(contents))),
        ),
    ).subscribe(render());
}
