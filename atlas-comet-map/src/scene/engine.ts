
import * as THREE from 'three';
import { useTime } from '../state/time';

export function createRenderer(container: HTMLDivElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.01, 1e9);
  camera.position.set(0, 5, 12);

  // lightweight manual orbit controls
  let dragging = false;
  let lx = 0, ly = 0;
  renderer.domElement.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
  renderer.domElement.addEventListener('mouseup',   () => { dragging = false; });
  renderer.domElement.addEventListener('mouseleave',() => { dragging = false; });
  renderer.domElement.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    camera.position.applyAxisAngle(new THREE.Vector3(0,1,0), -dx * 0.002);
    camera.position.applyAxisAngle(new THREE.Vector3(1,0,0), -dy * 0.002);
    camera.lookAt(0,0,0);
  });
  renderer.domElement.addEventListener('wheel', (e) => {
    const dir = Math.sign(e.deltaY);
    camera.position.multiplyScalar(1 + 0.08 * dir);
  });

  const resize = () => {
    const { clientWidth, clientHeight } = container;
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight);
  };
  new ResizeObserver(resize).observe(container);

  // Lights
  const sunLight = new THREE.PointLight(0xffffff, 2, 0);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x404040, 0.5));

  // Sun
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.15, 32, 16), new THREE.MeshBasicMaterial({ color: 0xffe080 }));
  scene.add(sun);

  // Animation loop
  let last = performance.now();
  const tick = (onFrame: (tms: number) => void) => {
    const now = performance.now();
    const dt = now - last;
    last = now;

    const { playing, speed, t, setT } = useTime.getState();
    if (playing) setT(t + dt * speed);

    onFrame(useTime.getState().t);
    renderer.render(scene, camera);
    requestAnimationFrame(() => tick(onFrame));
  };

  return { scene, camera, renderer, tick };
}
