import type { Route } from "./+types/home";
import { useEffect, useRef, useState } from "react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "아오야 포터리 | Aoya Pottery" },
    {
      name: "description",
      content:
        "수공예 도자기는 손에 쥐었을 때와 입에 닿았을 때의 감각으로 오래 기억됩니다. 아오야 포터리는 기억에 남는 감촉을 남깁니다.",
    },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;

  try {
    // Try to get display_order, fallback to uploaded_at if column doesn't exist
    const result = await db
      .prepare(
        "SELECT id, filename, url, size, uploaded_at, COALESCE(display_order, 999999) as display_order FROM files ORDER BY display_order ASC, uploaded_at DESC"
      )
      .all();

    return {
      images: result.results || [],
    };
  } catch (error) {
    // If display_order column doesn't exist, use uploaded_at
    try {
      const result = await db
        .prepare(
          "SELECT id, filename, url, size, uploaded_at FROM files ORDER BY uploaded_at DESC"
        )
        .all();
      return {
        images: result.results || [],
      };
    } catch (e) {
      console.error("Error loading images:", e);
      return {
        images: [],
      };
    }
  }
}

// Helper function to convert image URL to Cloudflare Transformations URL
function getTransformedImageUrl(
  originalUrl: string,
  options: {
    width?: number;
    quality?: number;
    format?: string;
  } = {}
): string {
  const { width = 1920, quality = 85, format = "auto" } = options;

  // If URL is already a Cloudflare Transformations URL, return as is
  if (originalUrl.includes("/cdn-cgi/image/")) {
    return originalUrl;
  }

  // Convert asset.aoya-pottery.com URL to Cloudflare Transformations URL
  // Format: https://aoya-pottery.com/cdn-cgi/image/{options}/{source_url}
  const transformationOptions = `width=${width},quality=${quality},format=${format}`;
  return `https://aoya-pottery.com/cdn-cgi/image/${transformationOptions}/${originalUrl}`;
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { images } = loaderData;
  const containerRef = useRef<HTMLDivElement>(null);
  const galleryRef = useRef<HTMLDivElement>(null);
  const textSectionRef = useRef<HTMLElement>(null);
  const splashRef = useRef<HTMLDivElement>(null);
  const [showSplash, setShowSplash] = useState(true);

  // Splash screen animation
  useEffect(() => {
    if (typeof window === "undefined" || !splashRef.current) return;

    const initSplash = async () => {
      const { gsap } = await import("gsap");

      // Wait a bit for logo to load
      await new Promise((resolve) => setTimeout(resolve, 500));

      const splash = splashRef.current;
      if (!splash) return;

      // Animate splash screen fade out
      gsap.to(splash, {
        opacity: 0,
        duration: 1.5,
        ease: "power2.inOut",
        onComplete: () => {
          setShowSplash(false);
        },
      });
    };

    initSplash();
  }, []);

  useEffect(() => {
    if (
      !galleryRef.current ||
      !containerRef.current ||
      images.length === 0 ||
      typeof window === "undefined"
    ) {
      return;
    }

    let gsapInstance: any = null;
    let ScrollTriggerInstance: any = null;
    let animations: any[] = [];

    const initAnimations = async () => {
      const gallery = galleryRef.current;
      const container = containerRef.current;
      const textSection = textSectionRef.current;
      if (!gallery || !container) return;

      // Force initial layout immediately (don't wait)
      requestAnimationFrame(() => {
        gallery.offsetHeight;
      });

      // Load GSAP immediately
      const gsapModule = await import("gsap");
      const { ScrollTrigger } = await import("gsap/ScrollTrigger");
      const gsap = gsapModule.default || gsapModule;
      gsap.registerPlugin(ScrollTrigger);
      gsapInstance = gsap;
      ScrollTriggerInstance = ScrollTrigger;

      // Only wait for first 2-3 images (critical above the fold)
      const imageElements = gallery.querySelectorAll("img");
      const criticalImages = Array.from(imageElements).slice(0, 3);

      // Wait for critical images with short timeout
      const criticalPromises = criticalImages.map((img: HTMLImageElement) => {
        return new Promise((resolve) => {
          if (img.complete && img.naturalWidth > 0) {
            resolve(img);
            return;
          }

          let resolved = false;
          const resolveOnce = () => {
            if (resolved) return;
            resolved = true;
            img.removeEventListener("load", onLoad);
            img.removeEventListener("error", onError);
            resolve(img);
          };

          const onLoad = resolveOnce;
          const onError = resolveOnce;

          img.addEventListener("load", onLoad);
          img.addEventListener("error", onError);

          // Short timeout - don't wait too long
          setTimeout(resolveOnce, 500);
        });
      });

      // Wait for critical images in parallel with initial setup
      await Promise.all(criticalPromises);

      // Force layout recalculation
      gallery.offsetHeight;

      // Initialize scroll animation immediately
      const calculateMaxScroll = () => {
        const galleryWidth = gallery.scrollWidth;
        const viewportWidth = gallery.clientWidth;
        return Math.max(0, galleryWidth - viewportWidth);
      };

      let maxScroll = calculateMaxScroll();

      // If dimensions not ready, retry with interval
      if (maxScroll <= 0) {
        const retryInterval = setInterval(() => {
          maxScroll = calculateMaxScroll();
          if (maxScroll > 0) {
            clearInterval(retryInterval);
            createScrollAnimation(maxScroll);
          }
        }, 50);

        // Stop retrying after 1.5 seconds
        setTimeout(() => {
          clearInterval(retryInterval);
          const finalScroll = calculateMaxScroll();
          if (finalScroll > 0) {
            createScrollAnimation(finalScroll);
          }
        }, 1500);
        return;
      }

      createScrollAnimation(maxScroll);
    };

    const createScrollAnimation = (maxScroll: number) => {
      const gallery = galleryRef.current;
      const container = containerRef.current;
      const textSection = textSectionRef.current;
      if (!gallery || !container || !gsapInstance) return;

      // Set initial states for images - start with visible state
      const imageItems = gallery.querySelectorAll(".gallery-item");
      imageItems.forEach((item: Element) => {
        const img = item.querySelector("img");
        if (img) {
          // Start with visible state, then animate to initial blur
          gsapInstance.set(img, {
            scale: 1.2,
            opacity: 0.6,
            filter: "blur(4px)",
          });
        }
      });

      // Horizontal scroll animation
      const scrollAnimation = gsapInstance.to(gallery, {
        scrollLeft: maxScroll,
        ease: "none",
        scrollTrigger: {
          trigger: container,
          start: "top top",
          end: () => `+=${window.innerHeight * 3}`,
          pin: true,
          scrub: 0.8,
          invalidateOnRefresh: true,
          onUpdate: (self: any) => {
            const progress = self.progress;
            const currentScroll = progress * maxScroll;

            // Update each image based on viewport position
            const imageItems = gallery.querySelectorAll(".gallery-item");
            imageItems.forEach((item: Element) => {
              const img = item.querySelector("img");
              if (!img) return;

              const itemRect = (item as HTMLElement).getBoundingClientRect();
              const galleryRect = gallery.getBoundingClientRect();
              const itemCenter = itemRect.left + itemRect.width / 2;
              const viewportCenter = galleryRect.left + galleryRect.width / 2;
              const distance = Math.abs(itemCenter - viewportCenter);
              const maxDistance = galleryRect.width * 0.7;
              const normalized = Math.min(distance / maxDistance, 1);

              const scale = 1.2 - normalized * 0.2;
              const opacity = 1 - normalized * 0.4;
              const blur = normalized * 3;

              gsapInstance.to(img, {
                scale: Math.max(scale, 1),
                opacity: Math.max(opacity, 0.6),
                filter: `blur(${blur}px)`,
                duration: 0.1,
                ease: "power1.out",
              });
            });
          },
        },
      });

      animations.push(scrollAnimation);

      // Text section animation
      if (textSection) {
        const title = textSection.querySelector("h1");
        const textBlocks = textSection.querySelectorAll(".text-block");

        gsapInstance.set([title, ...textBlocks], {
          opacity: 0,
          y: 60,
        });

        const textTimeline = gsapInstance.timeline({
          scrollTrigger: {
            trigger: textSection,
            start: "top 70%",
            end: "top 30%",
            scrub: 1.2,
          },
        });

        if (title) {
          textTimeline.to(
            title,
            {
              opacity: 1,
              y: 0,
              duration: 1,
              ease: "power4.out",
            },
            0
          );
        }

        textBlocks.forEach((block: Element, index: number) => {
          textTimeline.to(
            block,
            {
              opacity: 1,
              y: 0,
              duration: 0.8,
              ease: "power3.out",
            },
            0.3 + index * 0.15
          );
        });

        animations.push(textTimeline);
      }

      // Refresh after initialization - wait for all layouts to settle
      setTimeout(() => {
        // Force recalculation
        gallery.offsetHeight;
        ScrollTriggerInstance.refresh();
      }, 200);
    };

    initAnimations();

    const handleResize = () => {
      if (ScrollTriggerInstance) {
        ScrollTriggerInstance.refresh();
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      animations.forEach((anim) => {
        if (anim && anim.kill) anim.kill();
      });
      if (ScrollTriggerInstance) {
        ScrollTriggerInstance.getAll().forEach((st: any) => st.kill());
      }
    };
  }, [images.length]);

  return (
    <>
      {/* Splash Screen */}
      {showSplash && (
        <div ref={splashRef} className="splash-screen">
          <div className="splash-content">
            <img src="/logo.png" alt="Aoya Pottery" className="splash-logo" />
          </div>
        </div>
      )}

      <div ref={containerRef} className="main-container">
        {/* Gallery Section */}
        <section className="gallery-section">
          <div ref={galleryRef} className="gallery">
            {images.length > 0 ? (
              images.map((image: any, index: number) => {
                // Use Cloudflare Transformations for image optimization
                const transformedUrl = getTransformedImageUrl(image.url, {
                  width: 1920,
                  quality: 85,
                  format: "auto",
                });

                return (
                  <div key={image.id} className="gallery-item">
                    <div className="image-wrapper">
                      <img
                        src={transformedUrl}
                        alt={`Aoya Pottery ${index + 1}`}
                        loading={index < 4 ? "eager" : "lazy"}
                      />
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="gallery-item empty">
                <p>이미지를 업로드해주세요</p>
              </div>
            )}
          </div>
        </section>

        {/* Text Section */}
        <section ref={textSectionRef} className="text-section">
          <div className="text-container">
            <h1>The Texture Lasting in Memory.</h1>
            <div className="text-content">
              <div className="text-block">
                <p>
                  수공예 도자기는 손에 쥐었을 때와 입에 닿았을 때의 감각으로
                  오래 기억됩니다. 아오야 포터리는 기억에 남는 감촉을 남깁니다 ◌
                  ꩜
                </p>
              </div>
              <div className="text-block">
                <p>
                  모든 기물은 이천 공방에서 장작가마로 하나하나 빚어지며, 소량
                  한정 판매됩니다.
                </p>
              </div>
            </div>
          </div>
        </section>

        <style>{`
				* {
					margin: 0;
					padding: 0;
					box-sizing: border-box;
				}

				.splash-screen {
					position: fixed;
					top: 0;
					left: 0;
					width: 100vw;
					height: 100vh;
					background: #000;
					display: flex;
					align-items: center;
					justify-content: center;
					z-index: 9999;
					opacity: 1;
				}

				.splash-content {
					display: flex;
					align-items: center;
					justify-content: center;
					width: 100%;
					height: 100%;
				}

				.splash-logo {
					max-width: 60vw;
					max-height: 60vh;
					width: auto;
					height: auto;
					object-fit: contain;
				}

				@media (max-width: 768px) {
					.splash-logo {
						max-width: 80vw;
						max-height: 80vh;
					}
				}

				.main-container {
					width: 100%;
					min-height: 100vh;
					background: #fafafa;
					overflow-x: hidden;
				}

				.gallery-section {
					position: relative;
					width: 100%;
					height: 100vh;
					overflow: hidden;
					background: #000;
				}

				.gallery {
					display: flex;
					height: 100vh;
					overflow-x: auto;
					overflow-y: hidden;
					scroll-behavior: auto;
					-webkit-overflow-scrolling: touch;
				}

				.gallery::-webkit-scrollbar {
					display: none;
				}

				.gallery {
					-ms-overflow-style: none;
					scrollbar-width: none;
				}

				.gallery-item {
					flex-shrink: 0;
					width: 60vw;
					min-width: 60vw;
					height: 100vh;
					position: relative;
					display: flex;
					align-items: center;
					justify-content: center;
				}

				@media (max-width: 768px) {
					.gallery-item {
						width: 100vw;
						min-width: 100vw;
					}
				}

				.image-wrapper {
					width: 100%;
					height: 100%;
					position: relative;
					overflow: hidden;
					display: block;
				}

				.gallery-item img {
					width: 100%;
					height: 100%;
					object-fit: cover;
					object-position: center center;
					display: block;
					will-change: transform, opacity, filter;
					transform-origin: center center;
					backface-visibility: hidden;
					-webkit-backface-visibility: hidden;
					image-rendering: -webkit-optimize-contrast;
					image-rendering: crisp-edges;
				}

				.gallery-item.empty {
					display: flex;
					align-items: center;
					justify-content: center;
					background: #1a1a1a;
				}

				.gallery-item.empty p {
					color: #888;
					font-size: 1rem;
					font-weight: 300;
					letter-spacing: 0.05em;
				}

				.text-section {
					position: relative;
					width: 100%;
					min-height: 100vh;
					background: #fafafa;
					display: flex;
					align-items: center;
					justify-content: center;
					padding: 8rem 2rem;
				}

				@media (min-width: 768px) {
					.text-section {
						padding: 12rem 4rem;
					}
				}

				.text-container {
					max-width: 720px;
					width: 100%;
				}

				.text-section h1 {
					font-size: clamp(2.5rem, 5vw, 5rem);
					font-weight: 200;
					line-height: 1.1;
					letter-spacing: -0.03em;
					color: #1a1a1a;
					margin-bottom: 4rem;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
				}

				@media (min-width: 1024px) {
					.text-section h1 {
						margin-bottom: 5rem;
					}
				}

				.text-content {
					display: flex;
					flex-direction: column;
					gap: 2.5rem;
				}

				.text-block {
					opacity: 0;
				}

				.text-block p {
					font-size: clamp(1rem, 1.5vw, 1.25rem);
					line-height: 1.9;
					font-weight: 300;
					color: #4a4a4a;
					letter-spacing: 0.02em;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
				}

				@media (min-width: 1024px) {
					.text-content {
						gap: 3rem;
					}

					.text-block p {
						line-height: 2;
					}
				}
			`}</style>
      </div>
    </>
  );
}
