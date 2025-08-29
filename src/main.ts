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
    merge,
    startWith
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

abstract class RNG {
    private static m = 0x80000000; // 2^31
    private static a = 1103515245;
    private static c = 12345;

    static hash(seed: number): number {
        return (RNG.a * seed + RNG.c) % RNG.m;
    }
    static scale(hash: number): number {
        return (2 * hash) / (RNG.m - 1) - 1; // [-1, 1]
    }
}

/** Bounce magnitude in [4, 8] derived from a seed (pure) */
function generateBounceVelocity(seed: number): number {
    const h = RNG.hash(seed);
    const scaled = RNG.scale(h);      // [-1, 1]
    return 4 + Math.abs(scaled) * 4;  // [4, 8]
}

// User input

type Key = "Space";

// State processing
type PipeData = Readonly<{ time: number; gapY: number; gapH: number }>;
type LivePipe = Readonly<{ id: number; x: number; gapYpx: number; gapHpx: number; passed?: boolean;}>;

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
    collisionCooldown: number;
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
    collisionCooldown: 0,
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
        passed: false,
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

      // bird AABB (axis-aligned bounding box)
    const bx = Viewport.CANVAS_WIDTH * 0.3;
    const L = bx - Birb.WIDTH / 2;
    const R = bx + Birb.WIDTH / 2;
    const T = yClamped - Birb.HEIGHT / 2;
    const B = yClamped + Birb.HEIGHT / 2;

    // fold pipes → collisions + scoring
    let hit = false;
    let scoreInc = 0;
    const updatedPipes = moved.map(p => {
        const left   = p.x;
        const right  = p.x + Constants.PIPE_WIDTH;
        const gapTop = p.gapYpx - p.gapHpx / 2;
        const gapBot = p.gapYpx + p.gapHpx / 2;

        const overlapX = R > left && L < right;
        const hitTop    = overlapX && T < gapTop;
        const hitBottom = overlapX && B > gapBot;

        hit = hit || hitTop || hitBottom;

        const justPassed = !p.passed && L > right;
        if (justPassed) scoreInc += 1;

        return justPassed ? { ...p, passed: true } : p;
    });

    // also count top/bottom screen as collisions (spec)
    const screenHitTop = y < top;
    const screenHitBot = y > bot;
    hit = hit || screenHitTop || screenHitBot;

    // collision cooldown (invulnerability window)
    const nextCooldown = Math.max(0, s.collisionCooldown - Constants.TICK_RATE_MS);
    const collisionOccurred = (hit || screenHitTop || screenHitBot);
    const shouldConsumeLife = nextCooldown <= 0 && collisionOccurred && s.lives > 0;

    let birdVelocityNext = vy;
    let livesRemaining = s.lives;
    let cooldownRemaining = nextCooldown;

    if (shouldConsumeLife) {
        livesRemaining = s.lives - 1;
        cooldownRemaining = 600;

        const seed = Math.floor(t * 997 + s.score * 101 + s.lives * 13);
        const bounceMagnitude = generateBounceVelocity(seed);

        const collidedWithTopHalf =
        (y < top) ||
        updatedPipes.some(pipe => {
            const pipeLeft = pipe.x;
            const pipeRight = pipe.x + Constants.PIPE_WIDTH;
            const overlapX = R > pipeLeft && L < pipeRight;
            const gapTop = pipe.gapYpx - pipe.gapHpx / 2;
            return overlapX && T < gapTop;
        });

        birdVelocityNext = collidedWithTopHalf ? +bounceMagnitude : -bounceMagnitude;
    }

    const scoreNext = s.score + scoreInc;

    // end when lives exhausted OR finished all pipes and none left on screen
    const gameEnd =
        livesRemaining <= 0 ||
        (next >= sched.length && updatedPipes.length === 0);

    return {
        ...s,
        gameTime: t,
        birdVy: birdVelocityNext,
        birdY: yClamped,
        pipes: updatedPipes,            // keep moved pipes
        nextPipeIdx: next,              // remember where we are in the CSV
        lives: livesRemaining,
        score: scoreNext,
        gameEnd,
        collisionCooldown: cooldownRemaining,
    };
};

// ---- Actions & reducer (place this right after tick, before rendering) ----
type Action =
  | { type: "tick" }
  | { type: "flap" }
  | { type: "restart" };

const createReducer = (sched: readonly PipeData[]) =>
    (s: State, a: Action): State => {
        switch (a.type) {
        case "tick":
            return tick(s, sched);
        case "flap":
            return { ...s, gameStarted: true, birdVy: Constants.FLAP_VELOCITY };
        case "restart":
            return s.gameEnd ? { ...initialState } : s;
        default:
            return s;
        }
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
        const existingBird = svg.querySelector('#bird');
        if (existingBird) {
        existingBird.remove();
        }
        // Add birb to the main grid canvas
        const birdImg = createSvgElement(svg.namespaceURI, "image", {
            id: "bird",
            href: "assets/birb.png",
            x: `${Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2}`,
            y: `${s.birdY - Birb.HEIGHT / 2}`,
            width: `${Birb.WIDTH}`,
            height: `${Birb.HEIGHT}`,
        });
        svg.appendChild(birdImg);

        // Update lives and score text
        if (livesText) livesText.textContent = `${s.lives}`;
        if (scoreText) scoreText.textContent = `${s.score}`;


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
    const reducer = createReducer(sched);

    const key$ = fromEvent<KeyboardEvent>(document, "keypress");
    const fromKey = (keyCode: Key) =>
        key$.pipe(filter(({ code }) => code === keyCode));

    const flap$: Observable<Action> =
        fromKey("Space").pipe(map(() => ({ type: "flap" as const })));

    const tick$: Observable<Action> =
        interval(Constants.TICK_RATE_MS).pipe(map(() => ({ type: "tick" as const })));

    const keyDown$ = fromEvent<KeyboardEvent>(document, "keydown");
    const restart$ = keyDown$.pipe(
        filter(e => e.code === "KeyR"),
        map(() => ({ type: "restart" as const }))
    );

    return merge(tick$, flap$,restart$).pipe(
        scan(reducer, initialState)
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
