type Props = {
  title: string;
  preview?: string | null;
  onFile: (f: File) => void;
};

export default function UploadBox({ title, preview, onFile }: Props) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-sm font-semibold mb-2">{title}</div>
      <input
        type="file"
        accept="image/*"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        className="w-full"
      />
      {preview && (
        <img src={preview} alt="preview" className="mt-3 rounded-lg border border-gray-200 max-h-48 mx-auto" />
      )}
    </div>
  );
}
