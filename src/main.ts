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
    startWith,
    takeWhile,
    withLatestFrom,
    toArray,
    tap,
    BehaviorSubject,
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
    PIPE_SPEED: 5,          // pixel per tick (pipes move left)
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
type PipeData = Readonly<{ 
    time: number; 
    gapY: number; 
    gapH: number }>;

type LivePipe = Readonly<{ 
    id: number; 
    x: number; 
    gapYpx: number; 
    gapHpx: number; 
    passed?: boolean; 
    touched?: boolean; 
    blocked?: boolean;
}>;

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
    inContact: boolean;
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
    inContact: false,
};

/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
// Advance the game by one tick: pure in → pure out
const tick = (s: State, sched: readonly PipeData[]): State => {
    if (s.gameEnd) return s;                              // If the game already ended, freeze state

    const t = s.gameTime + 1;                             // Increment discrete time (tick counter)

    const ticksToSec = (ticks: number) =>                 // Helper: convert ticks → seconds
        (ticks * Constants.TICK_RATE_MS) / 1000;

    let next = s.nextPipeIdx;                             // Where we are in the pipe spawn schedule
    const spawned: LivePipe[] = [...s.pipes];             // Start from current live pipes (copy for immutability)

    // Spawn any pipes whose scheduled time has arrived
    while (next < sched.length && sched[next].time <= ticksToSec(t)) {
        const p = sched[next];                              // Scheduled pipe (normalized values)
        spawned.push({                                      // Add a new live pipe (in pixels)
        id: next,                                         // Unique id = schedule index
        x: Viewport.CANVAS_WIDTH,                         // Spawn at right edge of canvas
        gapYpx: p.gapY * Viewport.CANVAS_HEIGHT,          // Convert normalized gap center → px
        gapHpx: p.gapH * Viewport.CANVAS_HEIGHT,          // Convert normalized gap height → px
        passed: false,                                    // Not yet passed by the bird
        touched: false,
        blocked: false,
        });
        next++;                                             // Advance pointer to next scheduled pipe
    }

    // Move all pipes left; drop any that have fully exited the screen
    const moved = spawned
        .map(p => ({ ...p, x: p.x - Constants.PIPE_SPEED }))// Translate left by constant speed
        .filter(p => p.x + Constants.PIPE_WIDTH >= 0);       // Keep only pipes still visible

    // Integrate bird vertical motion (gravity)
    const vy = s.birdVy + Constants.GRAVITY;              // New vertical velocity with gravity
    const y  = s.birdY + vy;                              // New unclamped Y position

    // Vertical bounds (top/bottom the bird is allowed to be)
    const top = Birb.HEIGHT / 2;                          // Top limit (bird center cannot go above this)
    const bot = Viewport.CANVAS_HEIGHT - Birb.HEIGHT / 2; // Bottom limit
    const yClamped = Math.max(top, Math.min(bot, y));     // Clamp bird to screen

    // Bird’s axis-aligned bounding box (AABB) for collision tests
    const bx = Viewport.CANVAS_WIDTH * 0.3;               // Bird X anchor (fixed column)
    const L = bx - Birb.WIDTH / 2;                        // Bird left edge
    const R = bx + Birb.WIDTH / 2;                        // Bird right edge
    const T = yClamped - Birb.HEIGHT / 2;                 // Bird top edge
    const B = yClamped + Birb.HEIGHT / 2;                 // Bird bottom edge

    // fold pipes → collisions + scoring
    let hit = false;         // any pipe collision this frame?
    let scoreInc = 0;        // points to award this frame

    const updatedPipes = moved.map(p => {
    const left   = p.x;
    const right  = p.x + Constants.PIPE_WIDTH;
    const gapTop = p.gapYpx - p.gapHpx / 2;
    const gapBot = p.gapYpx + p.gapHpx / 2;

    const overlapX     = R > left && L < right;
    const hitThisPipe  = overlapX && (T < gapTop || B > gapBot); // collided this frame?

    // persist “ever touched” status
    const touched = (p.touched ?? false) || hitThisPipe;

    hit = hit || hitThisPipe;

    // passed = bird's left edge moved beyond pipe's right edge
    const justPassed = !p.passed && L > right;

    // score only if passed AND never touched this pipe
    if (justPassed && !touched) scoreInc += 1;

    return {
        ...p,
        passed: p.passed || justPassed,
        touched
    };
    });

    // Also count screen edges as collisions (spec requirement)
    const screenHitTop = y < top;                         // Would be above top if unclamped
    const screenHitBot = y > bot;                         // Would be below bottom if unclamped
    hit = hit || screenHitTop || screenHitBot;            // Merge screen-edge collisions

    // Collision detection already produced: hit, screenHitTop, screenHitBot
    const collisionOccurred = hit || screenHitTop || screenHitBot;

    // Edge trigger: life is consumed only when we *enter* contact
    const shouldConsumeLife = !s.inContact && collisionOccurred && s.lives > 0;

    let birdVelocityNext = vy;
    let livesRemaining   = s.lives;

    if (shouldConsumeLife) {
    livesRemaining = s.lives - 1;

    const seed = Math.floor(t * 997 + s.score * 101 + s.lives * 13);
    const bounceMagnitude = generateBounceVelocity(seed);

    const collidedWithTopHalf =
        (y < top) ||
        updatedPipes.some(pipe => {
        const left  = pipe.x, right = pipe.x + Constants.PIPE_WIDTH;
        const overlapX = R > left && L < right;
        const gapTop = pipe.gapYpx - pipe.gapHpx / 2;
        return overlapX && T < gapTop;
        });

    birdVelocityNext = collidedWithTopHalf ? +bounceMagnitude : -bounceMagnitude;
    }

    // next contact state: stay latched while colliding
    const inContactNext = collisionOccurred;
    const scoreNext = s.score + scoreInc;                 // Apply any score gained this frame

    // End when out of lives OR no more pipes to spawn and none left on screen
    const gameEnd =
        livesRemaining <= 0 ||
        (next >= sched.length && updatedPipes.length === 0);

    return {
        ...s,                                               // Copy previous state
        gameTime: t,                                        // Update tick counter
        birdVy: birdVelocityNext,                           // New vertical velocity (physics or bounce)
        birdY: yClamped,                                    // New clamped position
        pipes: updatedPipes,                                // Pipes after move/score flags
        nextPipeIdx: next,                                  // Where to resume spawning
        lives: livesRemaining,                              // Updated lives
        score: scoreNext,                                   // Updated score
        gameEnd,                                            // Whether game is over now
        inContact: inContactNext,
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

        // After drawing pipes
        if (s.gameEnd) {
        gameOver.setAttribute("visibility", "visible");

        // Move it to the end so it renders above pipes/bird
        gameOver.parentNode?.appendChild(gameOver); // or bringToForeground(gameOver)
        } else {
        gameOver.setAttribute("visibility", "hidden");
        }
    };
};

export const state$ = (csvContents: string): Observable<State> => {
  const sched = parseCsv(csvContents);

  const runGame = (): Observable<State> => {
    const key$  = fromEvent<KeyboardEvent>(document, "keydown");
    const flap$ = key$.pipe(
      filter(e => e.code === "Space"),
      map(() => (s: State) => ({ ...s, gameStarted: true, birdVy: Constants.FLAP_VELOCITY }))
    );
    const tick$ = interval(Constants.TICK_RATE_MS).pipe(
      map(() => (s: State) => tick(s, sched))
    );
    return merge(tick$, flap$).pipe(
      scan((s, f) => f(s), initialState),
      takeWhile(s => !s.gameEnd, true)
    );
  };

  const restart$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
    filter(e => e.code === "KeyR")
  );

  return restart$.pipe(
    startWith(null),
    switchMap(() => runGame())
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
