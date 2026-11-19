// The last step of a render: the path tracer's accumulated light (linear, floating point) becomes the
// picture. Noise filter, exposure, tone mapping, sRGB, and the background behind it.
import { Color, NoBlending, ShaderMaterial, Vector2, type Texture } from 'three';
import type { RenderSettings, ToneMapping } from '../core/render';

const toneMappingIndex: Record<ToneMapping, number> = { aces: 0, agx: 1, neutral: 2 };

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform vec2 texel;
  uniform float exposure;
  uniform int toneMapping;
  uniform bool backdrop;
  uniform vec3 backdropTop;
  uniform vec3 backdropBottom;
  uniform float sigma;
  varying vec2 vUv;

  // --- Tone mapping: the same curves as three.js' renderer has -----------------------------------
  vec3 RRTAndODTFit( vec3 v ) {
    vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
    vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
    return a / b;
  }
  vec3 aces( vec3 color ) {
    const mat3 ACESInputMat = mat3(
      vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );
    const mat3 ACESOutputMat = mat3(
      vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );
    color *= 1.0 / 0.6;
    color = ACESInputMat * color;
    color = RRTAndODTFit( color );
    color = ACESOutputMat * color;
    return clamp( color, 0.0, 1.0 );
  }
  vec3 agxContrast( vec3 x ) {
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }
  vec3 agx( vec3 color ) {
    const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
      vec3( 1.6605, - 0.1246, - 0.0182 ), vec3( - 0.5876, 1.1329, - 0.1006 ), vec3( - 0.0728, - 0.0083, 1.1187 ) );
    const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
      vec3( 0.6274, 0.0691, 0.0164 ), vec3( 0.3293, 0.9195, 0.0880 ), vec3( 0.0433, 0.0113, 0.8956 ) );
    const mat3 AgXInsetMatrix = mat3(
      vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
      vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
      vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
    const mat3 AgXOutsetMatrix = mat3(
      vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
      vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
      vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ) );
    const float AgxMinEv = - 12.47393;
    const float AgxMaxEv = 4.026069;
    color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
    color = AgXInsetMatrix * color;
    color = max( color, 1e-10 );
    color = log2( color );
    color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
    color = clamp( color, 0.0, 1.0 );
    color = agxContrast( color );
    color = AgXOutsetMatrix * color;
    color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
    color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
    return clamp( color, 0.0, 1.0 );
  }
  vec3 neutral( vec3 color ) {
    const float StartCompression = 0.8 - 0.04;
    const float Desaturation = 0.15;
    float x = min( color.r, min( color.g, color.b ) );
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max( color.r, max( color.g, color.b ) );
    if ( peak < StartCompression ) return color;
    float d = 1.0 - StartCompression;
    float newPeak = 1.0 - d * d / ( peak + d - StartCompression );
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / ( Desaturation * ( peak - newPeak ) + 1.0 );
    return mix( color, vec3( newPeak ), g );
  }
  vec3 toSrgb( vec3 c ) {
    return mix( c * 12.92, 1.055 * pow( max( c, 0.0 ), vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
  }

  // --- The accumulated image ---------------------------------------------------------------------
  // rgb: light, with the exposure applied (the target holds it premultiplied by coverage); a: coverage.
  vec4 light( vec2 uv ) {
    vec4 t = texture2D( map, uv );
    if ( any( isnan( t ) ) || any( isinf( t ) ) ) return vec4( 0.0 );
    float a = clamp( t.a, 0.0, 1.0 );
    vec3 c = a > 1e-4 ? max( t.rgb, 0.0 ) / a : vec3( 0.0 );
    return vec4( c * exposure, a );
  }
  float peak( vec3 c ) { return max( c.r, max( c.g, c.b ) ); }
  // Brightness compressed to 0..1, so that a few very bright samples do not outweigh everything in an average.
  vec3 compress( vec3 c ) { return c / ( 1.0 + peak( c ) ); }
  vec3 expand( vec3 c ) { return c / max( 1.0 - peak( c ), 1e-4 ); }

  float hash( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  void main() {
    vec4 centre = light( vUv );
    vec3 color = centre.rgb;

    if ( sigma > 0.0 ) {
      // Fireflies: a pixel far brighter than everything around it is one unlucky light path, not detail.
      // Compared with the average of its neighbours, the brightest of them left out (it may be another one).
      float sum8 = 0.0;
      float max8 = 0.0;
      for ( int y = - 1; y <= 1; y ++ ) {
        for ( int x = - 1; x <= 1; x ++ ) {
          if ( x == 0 && y == 0 ) continue;
          float p = peak( light( vUv + vec2( x, y ) * texel ).rgb );
          sum8 += p;
          max8 = max( max8, p );
        }
      }
      float limit = ( sum8 - max8 ) / 7.0 * 4.0 + 0.03;
      float own = peak( color );
      if ( own > limit ) color *= limit / own;

      // Edge-preserving blur: neighbours count the more the closer their colour is to this pixel's.
      // Differences are judged on square roots: there, path-tracing noise is about as strong in the dark as in the light.
      vec3 mid = compress( color );
      vec3 midRoot = sqrt( mid );
      vec3 sum = mid;
      float weight = 1.0;
      float range = 1.0 / ( 2.0 * sigma * sigma );
      for ( int y = - 3; y <= 3; y ++ ) {
        for ( int x = - 3; x <= 3; x ++ ) {
          if ( x == 0 && y == 0 ) continue;
          vec4 tap = light( vUv + vec2( x, y ) * texel );
          vec3 c = compress( tap.rgb );
          vec3 d = sqrt( c ) - midRoot;
          float da = tap.a - centre.a;
          float w = exp( - float( x * x + y * y ) / 8.0 - ( dot( d, d ) + da * da ) * range );
          sum += c * w;
          weight += w;
        }
      }
      color = expand( sum / weight );
    }

    if ( toneMapping == 0 ) color = aces( color );
    else if ( toneMapping == 1 ) color = agx( color );
    else color = clamp( neutral( color ), 0.0, 1.0 );
    color = toSrgb( color );

    float alpha = centre.a;
    if ( backdrop ) {
      // Colours of the backdrop are display colours: they are not tone mapped, the picture is laid over them.
      color = mix( mix( backdropBottom, backdropTop, vUv.y ), color, alpha );
      alpha = 1.0;
    }
    // Half a step of noise, so that slow gradients do not show bands in 8 bits.
    color += ( hash( gl_FragCoord.xy ) - 0.5 ) / 255.0;
    gl_FragColor = vec4( clamp( color, 0.0, 1.0 ), alpha );
  }
`;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

/** The filter's reach in compressed colour (0..1): how different a neighbour may be and still count. */
export function denoiseSigma(strength: number, samples: number): number {
  if (strength <= 0 || samples <= 0) return 0;
  // Noise falls with the square root of the sample count, and the filter with it.
  return 0.3 * strength * Math.min(1, 4 / Math.sqrt(samples));
}

export class OutputMaterial extends ShaderMaterial {
  constructor() {
    super({
      vertexShader,
      fragmentShader,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        map: { value: null },
        texel: { value: new Vector2(1, 1) },
        exposure: { value: 1 },
        toneMapping: { value: 1 },
        backdrop: { value: false },
        backdropTop: { value: new Color() },
        backdropBottom: { value: new Color() },
        sigma: { value: 0 },
      },
    });
  }

  /** `samples`: how many samples per pixel `map` holds. */
  update(map: Texture, width: number, height: number, settings: RenderSettings, samples: number): void {
    const u = this.uniforms;
    u.map.value = map;
    u.texel.value.set(1 / width, 1 / height);
    u.exposure.value = 2 ** settings.output.exposure;
    u.toneMapping.value = toneMappingIndex[settings.output.toneMapping];
    const { type, color, topColor } = settings.background;
    u.backdrop.value = type === 'color' || type === 'gradient';
    // Display colours, used as they are: no conversion to linear.
    setHex(u.backdropBottom.value, color);
    setHex(u.backdropTop.value, type === 'gradient' ? topColor : color);
    u.sigma.value = denoiseSigma(settings.output.denoise, samples);
  }
}

function setHex(target: Color, hex: string): void {
  const n = parseInt(hex.slice(1), 16);
  target.setRGB(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
