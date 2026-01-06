import type { Route } from "./+types/upload";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { useState, useRef, useEffect } from "react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Upload Photos - Aoya Pottery" },
    { name: "description", content: "Upload and manage photos" },
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
      files: result.results || [],
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
        files: result.results || [],
      };
    } catch (e) {
      console.error("Error loading files:", e);
      return {
        files: [],
      };
    }
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Helper to return JSON response
  const jsonResponse = (
    data: { success: boolean; message?: string },
    status = 200
  ) => {
    return Response.json(data, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  if (intent === "reorder") {
    const orderData = formData.get("order") as string;
    if (!orderData) {
      return jsonResponse(
        { success: false, message: "No order data provided" },
        400
      );
    }

    try {
      const order = JSON.parse(orderData) as Array<{
        id: string;
        order: number;
      }>;
      const db = context.cloudflare.env.DB;

      // Try to add display_order column if it doesn't exist
      try {
        await db
          .prepare("ALTER TABLE files ADD COLUMN display_order INTEGER")
          .run();
      } catch (e) {
        // Column might already exist, ignore error
      }

      // Update display_order for each file
      for (const item of order) {
        await db
          .prepare("UPDATE files SET display_order = ? WHERE id = ?")
          .bind(item.order, item.id)
          .run();
      }

      return jsonResponse({
        success: true,
        message: "Order updated successfully",
      });
    } catch (error) {
      console.error("Error updating order:", error);
      return jsonResponse(
        { success: false, message: "Failed to update order" },
        500
      );
    }
  }

  if (intent === "delete") {
    const fileId = formData.get("id") as string;
    const filename = formData.get("filename") as string;

    try {
      // Delete from R2
      const { S3Client, DeleteObjectCommand } =
        await import("@aws-sdk/client-s3");
      const s3Client = new S3Client({
        region: "auto",
        endpoint:
          "https://f668dfa8580d3ffda32d5ca87213d141.r2.cloudflarestorage.com",
        credentials: {
          accessKeyId: context.cloudflare.env.S3_ACCESS_KEY_ID,
          secretAccessKey: context.cloudflare.env.S3_SECRET_ACCESS_KEY,
        },
      });

      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: "aoya-pottery",
          Key: filename,
        })
      );

      // Delete from D1
      const db = context.cloudflare.env.DB;
      await db.prepare("DELETE FROM files WHERE id = ?").bind(fileId).run();

      return jsonResponse({
        success: true,
        message: "File deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting file:", error);
      return jsonResponse(
        { success: false, message: "Failed to delete file" },
        500
      );
    }
  }

  if (intent === "upload") {
    const file = formData.get("file") as File;

    if (!file) {
      return jsonResponse({ success: false, message: "No file provided" }, 400);
    }

    // Check file size limit (50MB)
    const maxFileSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxFileSize) {
      return jsonResponse(
        {
          success: false,
          message: `File size exceeds 50MB limit. Please use a smaller image.`,
        },
        400
      );
    }

    try {
      // Upload to R2
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const s3Client = new S3Client({
        region: "auto",
        endpoint:
          "https://f668dfa8580d3ffda32d5ca87213d141.r2.cloudflarestorage.com",
        credentials: {
          accessKeyId: context.cloudflare.env.S3_ACCESS_KEY_ID,
          secretAccessKey: context.cloudflare.env.S3_SECRET_ACCESS_KEY,
        },
      });

      const db = context.cloudflare.env.DB;

      // Get existing filenames to check for duplicates
      const existingFilesResult = await db
        .prepare("SELECT filename FROM files")
        .all();
      const existingFilenames = new Set(
        (existingFilesResult.results || []).map((f: any) => f.filename)
      );

      // For large files, process more carefully to avoid memory issues
      let optimizedBuffer: Uint8Array;
      let contentType: string;

      // Process image with @cf-wasm/photon: resize and optimize
      const { PhotonImage, SamplingFilter, resize } =
        await import("@cf-wasm/photon/workerd");

      // Read file buffer in chunks if very large to reduce peak memory
      const fileBuffer = await file.arrayBuffer();
      const inputBytes = new Uint8Array(fileBuffer);

      // Create PhotonImage instance
      let inputImage: any = null;
      let outputImage: any = null;

      try {
        inputImage = PhotonImage.new_from_byteslice(inputBytes);

        // Clear input buffer reference immediately to free memory
        inputBytes.fill(0);
        // @ts-ignore - Force GC hint
        if (globalThis.gc) globalThis.gc();

        // Determine target size based on original dimensions and file size
        const originalWidth = inputImage.get_width();
        const originalHeight = inputImage.get_height();
        const fileSizeMB = file.size / (1024 * 1024);

        // Adaptive resizing based on file size and dimensions
        let maxWidth = 1920;
        let quality = 75;

        // For very large files or images, resize more aggressively
        if (fileSizeMB > 20 || originalWidth > 5000 || originalHeight > 5000) {
          maxWidth = 1600;
          quality = 70;
        } else if (
          fileSizeMB > 10 ||
          originalWidth > 4000 ||
          originalHeight > 4000
        ) {
          maxWidth = 1800;
          quality = 72;
        } else if (originalWidth > 3000 || originalHeight > 3000) {
          maxWidth = 1920;
          quality = 75;
        }

        const needsResize = originalWidth > maxWidth;

        if (needsResize) {
          const aspectRatio = originalHeight / originalWidth;
          const newHeight = Math.round(maxWidth * aspectRatio);

          // Use faster sampling for very large images to save memory
          const filter =
            originalWidth > 5000 || fileSizeMB > 20
              ? SamplingFilter.Triangle
              : SamplingFilter.Lanczos3;

          outputImage = resize(inputImage, maxWidth, newHeight, filter);

          // Free input image immediately after resize
          inputImage.free();
          inputImage = null;

          // @ts-ignore - Force GC hint
          if (globalThis.gc) globalThis.gc();
        } else {
          outputImage = inputImage;
        }

        // Convert to JPEG with optimized quality
        optimizedBuffer = outputImage.get_bytes_jpeg(quality);
        contentType = "image/jpeg";

        // Free output image immediately
        outputImage.free();
        outputImage = null;

        // @ts-ignore - Force GC hint
        if (globalThis.gc) globalThis.gc();

        // Generate filename with .jpg extension (optimized format)
        const originalName = file.name;
        const lastDotIndex = originalName.lastIndexOf(".");
        const nameWithoutExt =
          lastDotIndex > 0
            ? originalName.substring(0, lastDotIndex)
            : originalName;
        let filename = `${nameWithoutExt}.jpg`;

        // Check if filename already exists, if so, add timestamp before extension
        if (existingFilenames.has(filename)) {
          const timestamp = Date.now();
          filename = `${nameWithoutExt}-${timestamp}.jpg`;
        }

        // Add to set to prevent duplicates within the same upload batch
        existingFilenames.add(filename);

        // Upload to R2
        await s3Client.send(
          new PutObjectCommand({
            Bucket: "aoya-pottery",
            Key: filename,
            Body: optimizedBuffer,
            ContentType: contentType,
            ACL: "public-read",
          })
        );

        // Clear optimized buffer reference
        const bufferSize = optimizedBuffer.length;

        // Save metadata to D1
        const url = `https://asset.aoya-pottery.com/${filename}`;

        // Try to add display_order column if it doesn't exist
        try {
          await db
            .prepare("ALTER TABLE files ADD COLUMN display_order INTEGER")
            .run();
        } catch (e) {
          // Column might already exist, ignore error
        }

        // Get max display_order to set new item at the end
        let newOrder = 1;
        try {
          const maxOrderResult = await db
            .prepare("SELECT MAX(display_order) as max_order FROM files")
            .first();
          const maxOrder = (maxOrderResult as any)?.max_order;
          if (maxOrder !== null && maxOrder !== undefined) {
            newOrder = maxOrder + 1;
          }
        } catch (e) {
          // If display_order doesn't exist yet, start from 1
          newOrder = 1;
        }

        await db
          .prepare(
            "INSERT INTO files (id, filename, url, size, content_type, uploaded_at, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(
            crypto.randomUUID(),
            filename,
            url,
            bufferSize,
            contentType,
            new Date().toISOString(),
            newOrder
          )
          .run();

        return jsonResponse({
          success: true,
          message: "File uploaded successfully",
        });
      } finally {
        // Ensure memory is freed even if there's an error
        if (inputImage) {
          try {
            inputImage.free();
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
        if (outputImage) {
          try {
            outputImage.free();
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
      }
    } catch (error) {
      console.error("Error uploading files:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to upload file";

      // Check if it's a memory error
      if (errorMessage.includes("memory") || errorMessage.includes("Memory")) {
        return jsonResponse(
          {
            success: false,
            message:
              "File is too large or complex. Please try reducing the image dimensions or use a smaller file.",
          },
          413
        );
      }

      return jsonResponse(
        {
          success: false,
          message: errorMessage,
        },
        500
      );
    }
  }

  return jsonResponse({ success: false, message: "Invalid action" }, 400);
}

type UploadStatus = {
  file: File;
  status: "pending" | "uploading" | "success" | "error";
  message?: string;
};

export default function Upload({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { files } = useLoaderData<typeof loader>();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadStatuses, setUploadStatuses] = useState<
    Map<number, UploadStatus>
  >(new Map());
  const [isDragging, setIsDragging] = useState(false);
  const [orderedFiles, setOrderedFiles] = useState<any[]>(files);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const submit = useSubmit();

  // Update orderedFiles when files change
  useEffect(() => {
    setOrderedFiles(files);
  }, [files]);

  const handleFiles = (fileList: FileList | null) => {
    if (fileList) {
      const newFiles = Array.from(fileList);
      setSelectedFiles((prev) => {
        // Merge with existing files, avoiding duplicates by name
        const existingNames = new Set(prev.map((f) => f.name));
        const uniqueNewFiles = newFiles.filter(
          (f) => !existingNames.has(f.name)
        );
        return [...prev, ...uniqueNewFiles];
      });
    }
  };

  const handleDropZoneDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDropZoneDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDropZoneDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDropZoneDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) {
      handleFiles(droppedFiles);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // Drag and drop handlers for reordering
  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    setDragOverIndex(null);

    if (draggedIndex === null || draggedIndex === dropIndex) {
      setDraggedIndex(null);
      return;
    }

    const newOrder = [...orderedFiles];
    const [draggedItem] = newOrder.splice(draggedIndex, 1);
    newOrder.splice(dropIndex, 0, draggedItem);

    setOrderedFiles(newOrder);
    setDraggedIndex(null);

    // Save new order to database
    const orderData = newOrder.map((file, index) => ({
      id: file.id,
      order: index + 1,
    }));

    const formData = new FormData();
    formData.append("intent", "reorder");
    formData.append("order", JSON.stringify(orderData));

    submit(formData, { method: "post" });
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  // Upload each file individually using fetchers
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (selectedFiles.length === 0) return;

    // Initialize upload statuses
    const initialStatuses = new Map<number, UploadStatus>();
    selectedFiles.forEach((file, index) => {
      initialStatuses.set(index, { file, status: "pending" });
    });
    setUploadStatuses(initialStatuses);

    // Upload each file individually using Promise.all for parallel uploads
    const uploadPromises = selectedFiles.map(async (file, i) => {
      // Update status to uploading
      setUploadStatuses((prev) => {
        const newMap = new Map(prev);
        newMap.set(i, { file, status: "uploading" });
        return newMap;
      });

      try {
        const formData = new FormData();
        formData.append("intent", "upload");
        formData.append("file", file);

        // Upload file - don't expect JSON response
        const response = await fetch(window.location.pathname, {
          method: "POST",
          body: formData,
        });

        // If response is OK (200-299), consider it successful
        // React Router might return HTML, but if status is OK, upload likely succeeded
        if (response.ok) {
          setUploadStatuses((prev) => {
            const newMap = new Map(prev);
            newMap.set(i, {
              file,
              status: "success",
              message: "File uploaded successfully",
            });
            return newMap;
          });
        } else {
          // HTTP error - get error message if possible
          let errorMessage = `Upload failed: HTTP ${response.status}`;
          try {
            const errorText = await response.text();
            // Try to extract error message from HTML if present
            const errorMatch = errorText.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (errorMatch) {
              errorMessage = errorMatch[1];
            }
          } catch (e) {
            // Ignore parsing errors
          }

          setUploadStatuses((prev) => {
            const newMap = new Map(prev);
            newMap.set(i, {
              file,
              status: "error",
              message: errorMessage,
            });
            return newMap;
          });
        }
      } catch (error) {
        console.error(`Error uploading ${file.name}:`, error);
        const errorMessage =
          error instanceof Error ? error.message : "Upload failed";
        setUploadStatuses((prev) => {
          const newMap = new Map(prev);
          newMap.set(i, {
            file,
            status: "error",
            message: errorMessage,
          });
          return newMap;
        });
      }
    });

    // Wait for all uploads to complete
    await Promise.all(uploadPromises);

    // Reload file list after all uploads complete
    setTimeout(() => {
      window.location.reload();
    }, 1500);
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Photo Upload</h1>

        {/* Upload Form */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Upload Photos</h2>
          <Form
            method="post"
            encType="multipart/form-data"
            onSubmit={handleSubmit}
          >
            <div className="mb-4">
              {/* Drag and Drop Zone */}
              <div
                ref={dropZoneRef}
                onDragEnter={handleDropZoneDragEnter}
                onDragOver={handleDropZoneDragOver}
                onDragLeave={handleDropZoneDragLeave}
                onDrop={handleDropZoneDrop}
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                  isDragging
                    ? "border-blue-500 bg-blue-50"
                    : "border-gray-300 hover:border-gray-400"
                }`}
              >
                <div className="space-y-2">
                  <svg
                    className="mx-auto h-12 w-12 text-gray-400"
                    stroke="currentColor"
                    fill="none"
                    viewBox="0 0 48 48"
                    aria-hidden="true"
                  >
                    <path
                      d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <div className="text-sm text-gray-600">
                    <label
                      htmlFor="file"
                      className="relative cursor-pointer rounded-md font-medium text-blue-600 focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2"
                    >
                      <span>Click to select</span>
                      <input
                        ref={fileInputRef}
                        type="file"
                        id="file"
                        name="file"
                        accept="image/*"
                        multiple
                        onChange={(e) => {
                          handleFiles(e.target.files);
                          // Reset input to allow selecting the same file again
                          if (e.target) {
                            (e.target as HTMLInputElement).value = "";
                          }
                        }}
                        className="sr-only"
                      />
                    </label>
                    <span className="pl-1">or drag and drop</span>
                  </div>
                  <p className="text-xs text-gray-500">
                    PNG, JPG, GIF up to 50MB each
                  </p>
                </div>
              </div>

              {selectedFiles.length > 0 && (
                <div className="mt-4 p-4 bg-gray-50 rounded-md">
                  <p className="text-sm font-medium text-gray-700 mb-3">
                    Selected {selectedFiles.length} file(s):
                  </p>
                  <ul className="space-y-2 max-h-60 overflow-y-auto">
                    {selectedFiles.map((file, index) => {
                      const status = uploadStatuses.get(index);
                      const statusColor =
                        status?.status === "success"
                          ? "text-green-600"
                          : status?.status === "error"
                            ? "text-red-600"
                            : status?.status === "uploading"
                              ? "text-blue-600"
                              : "text-gray-500";
                      return (
                        <li
                          key={index}
                          className="flex items-center justify-between p-2 bg-white rounded border border-gray-200"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-900 truncate">
                              {file.name}
                            </p>
                            <p className="text-xs text-gray-500">
                              {(file.size / 1024 / 1024).toFixed(2)} MB
                            </p>
                            {status && (
                              <p className={`text-xs mt-1 ${statusColor}`}>
                                {status.status === "uploading" &&
                                  "⏳ Uploading..."}
                                {status.status === "success" &&
                                  "✅ " + (status.message || "Uploaded")}
                                {status.status === "error" &&
                                  "❌ " + (status.message || "Failed")}
                                {status.status === "pending" && "⏸ Pending..."}
                              </p>
                            )}
                          </div>
                          {!status || status.status !== "uploading" ? (
                            <button
                              type="button"
                              onClick={() => removeFile(index)}
                              className="ml-2 text-red-600 hover:text-red-800 text-sm font-medium"
                            >
                              Remove
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="text-xs text-gray-500 mt-3">
                    Total size:{" "}
                    {(
                      selectedFiles.reduce((sum, f) => sum + f.size, 0) /
                      1024 /
                      1024
                    ).toFixed(2)}{" "}
                    MB
                  </p>
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={
                selectedFiles.length === 0 ||
                Array.from(uploadStatuses.values()).some(
                  (s) => s.status === "uploading"
                )
              }
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {Array.from(uploadStatuses.values()).some(
                (s) => s.status === "uploading"
              )
                ? "Uploading..."
                : `Upload ${selectedFiles.length || ""} Photo${selectedFiles.length !== 1 ? "s" : ""}`}
            </button>
          </Form>
        </div>

        {/* Files List */}
        <div className="bg-white rounded-lg shadow-md p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Uploaded Photos</h2>
            <p className="text-sm text-gray-500">
              드래그하여 순서를 변경할 수 있습니다
            </p>
          </div>
          {orderedFiles.length === 0 ? (
            <p className="text-gray-500">No photos uploaded yet.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {orderedFiles.map((file: any, index: number) => (
                <div
                  key={file.id}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, index)}
                  onDragEnd={handleDragEnd}
                  className={`border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-all cursor-move ${
                    draggedIndex === index
                      ? "opacity-50 scale-95"
                      : dragOverIndex === index
                        ? "border-blue-500 border-2 scale-105"
                        : ""
                  }`}
                >
                  <div className="aspect-square bg-gray-100 relative">
                    <div className="absolute top-2 left-2 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded z-10">
                      #{index + 1}
                    </div>
                    <img
                      src={file.url}
                      alt={file.filename}
                      className="w-full h-full object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src =
                          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23ddd' width='100' height='100'/%3E%3Ctext fill='%23999' font-family='sans-serif' font-size='14' dy='10.5' x='50%25' y='50%25' text-anchor='middle'%3ENo Image%3C/text%3E%3C/svg%3E";
                      }}
                    />
                  </div>
                  <div className="p-4">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {file.filename}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {(file.size / 1024).toFixed(2)} KB
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      {new Date(file.uploaded_at).toLocaleDateString()}
                    </p>
                    <Form method="post" className="mt-3">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={file.id} />
                      <input
                        type="hidden"
                        name="filename"
                        value={file.filename}
                      />
                      <button
                        type="submit"
                        className="w-full px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                      >
                        Delete
                      </button>
                    </Form>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
